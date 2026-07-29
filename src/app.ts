import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
  MessageFlags,
  type Interaction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
  type AnyThreadChannel,
} from "discord.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Config } from "./config.js";
import { acquireSingleInstanceLock, type InstanceLock } from "./core/single-instance.js";
import { lockPath, sessionStorePath } from "./core/paths.js";
import { resolveControlledRepo } from "./core/repo.js";
import { gitDiffSummary } from "./core/git.js";
import { downloadBounded } from "./core/download.js";
import { SessionStore, type SessionRecord } from "./core/session-store.js";
import { planReconcile, classifyResumeError, type ThreadStatus } from "./core/reconcile.js";
import { deriveThreadTitle, THREAD_NAME_MAX } from "./core/thread-name.js";
import { pickTitleModel, buildTitlePrompt, cleanModelTitle } from "./core/title.js";
import { randomUUID } from "node:crypto";

import { sendUnlessAborted } from "./core/turn-gate.js";
import { shouldResetEffort, validateEffort, EFFORT_LEVELS } from "./core/effort.js";
import { createCopilotClient, checkSdkCompat } from "./copilot/sdk.js";
import { PendingInteractionBroker, type PendingView } from "./core/broker.js";
import { SessionActor, type BlobAttachment, formatTodos } from "./copilot/session-actor.js";
import { ApprovalPolicy } from "./core/approval-policy.js";
import { DiscordTransport } from "./platforms/discord/discord-transport.js";
import { decodePermissionId, decodeChoiceId, decodePlanId } from "./platforms/discord/custom-id.js";
import { isAuthorized, type AuthContext, type AuthPolicy } from "./platforms/discord/auth.js";
import type { Decision, Transport } from "./core/transport.js";

/** One live Discord thread ↔ Copilot session. Exported so tests can build a
 *  TYPED fixture — an untyped `as Record<string, unknown>` fixture is how a
 *  missing field reaches runtime instead of the typechecker. */
export interface Session {
  actor: SessionActor;
  broker: PendingInteractionBroker;
  running: boolean;
  /** Set while a turn is reserved but the prompt hasn't been handed to the agent
   *  yet (e.g. during image download). /stop aborts this to cancel before send. */
  currentAbort?: AbortController;
  /** True once the thread carries a real title (from /new's prompt option, a
   *  first message, an explicit /rename, or because it is a RESUMED thread that
   *  was already named). Gates the one automatic rename per session. */
  titled: boolean;
  /** Bumped by every explicit /rename. A titler that was already in flight
   *  compares this before writing, so it can never clobber a name the operator
   *  just chose. */
  titleEpoch: number;
  /** Prompts waiting to run after the current turn, added with `/queue`. Held
   *  HERE and not in the runtime's own queue on purpose: `session.abort()` does
   *  NOT drain the runtime queue (verified — a queued message still ran after an
   *  abort), so `/stop` could not honestly stop anything we had pushed there. */
  queue: string[];
}

/** The subset of an SDK session the throwaway titler uses. */
interface TitlerSession {
  sessionId?: string;
  on(ev: string, h: (e: unknown) => void): void;
  send(o: Record<string, unknown>): Promise<unknown>;
  disconnect?: () => Promise<unknown>;
}

/** Most prompts `/queue` will hold. A queue is a convenience, not a job runner;
 *  an unbounded one just defers a pile of work the operator has forgotten
 *  about onto an unattended machine. */
const QUEUE_MAX = 10;

/** Milliseconds a single session teardown may take during /new before we give
 *  up on it (and keep it for a later retry) rather than stalling. */
const TEARDOWN_TIMEOUT_MS = 5_000;

/** Milliseconds the thread titler may take. Generous enough for a cold model
 *  start, short enough that a wedged titler falls back to the local heuristic
 *  while the thread name still matters. */
const TITLE_TIMEOUT_MS = 25_000;

/** Format an executable list for a compact reply. */
function fmtList(items: string[]): string {
  return items.length ? items.map((e) => `\`${e}\``).join(", ") : "(none)";
}

/** Reject if `p` doesn't settle within `ms` (the pending work keeps running). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Ack the Discord button interaction BEFORE settling the decision. On ack
 *  success the user's decision is delivered; on ack failure the SAFE default
 *  (deny) is delivered instead, so an Allow never runs while Discord shows an
 *  error. Pure + exported for unit tests. */
export async function resolveButtonAck(
  ack: () => Promise<unknown>,
  deliver: (d: Decision) => void,
  action: Decision
): Promise<void> {
  try {
    await ack();
  } catch {
    deliver("deny");
    return;
  }
  deliver(action);
}

/** Cross-thread guard (§9: "跨 thread 點擊無法 resolve"). A permission/choice/plan
 *  decision may only settle a nonce whose owning session is the very thread the
 *  interaction arrived from. The nonce is unique + Discord-validated, so this is
 *  defense-in-depth: returns true iff the pending request exists AND its
 *  sessionKey matches the interaction's channel; false for a missing pending
 *  (expired) or a mismatched channel (a click from another thread). */
export function decisionBindsToChannel(
  pending: { sessionKey: string } | undefined,
  channelId: string
): boolean {
  return pending !== undefined && pending.sessionKey === channelId;
}

/**
 * The session keys `/approvals` must act on. v1 runs ONE live session, and the
 * command is usable from the parent channel as well as from a session thread —
 * so scoping to `interaction.channelId` meant `/approvals clear:true` run from
 * the parent channel cleared only the on-disk repo rules while the LIVE
 * session's in-memory rules survived, under a reply that said "Cleared
 * approvals … Future commands will prompt again." A false revocation claim on a
 * security control is worse than no command, so "clear my approvals" means every
 * live session, wherever the command was typed. (Torn-down threads hold no
 * in-memory rules, so an empty result is genuinely nothing to clear.)
 */
export function approvalScopeKeys(liveSessionKeys: Iterable<string>): string[] {
  return [...new Set(liveSessionKeys)];
}

/**
 * Whether a message arrived in a thread WE created under the configured parent
 * channel — i.e. a thread that once carried a session and no longer does.
 *
 * `/new` ends the previous session (v1 runs one at a time), after which typing
 * into the old thread did nothing at all: `onMessage` returned silently because
 * there was no live session for that channel. The thread does carry a "this one
 * has ended" notice from when it was superseded, but anything typed afterwards
 * vanished with no explanation.
 *
 * Deliberately narrow, and fails closed on anything unknown: we only speak in
 * threads the bot itself opened under the configured parent, never in the parent
 * channel and never in the operator's own threads.
 */
export function isOurEndedThread(o: {
  channelIsThread: boolean;
  threadParentId?: string;
  threadOwnerId?: string;
  configuredParentChannelId: string;
  botUserId?: string;
}): boolean {
  if (!o.channelIsThread) return false;
  if (!o.threadParentId || o.threadParentId !== o.configuredParentChannelId) return false;
  if (!o.botUserId || !o.threadOwnerId || o.threadOwnerId !== o.botUserId) return false;
  return true;
}

/**
 * Apply a `/yolo` toggle with the ack-before-allow invariant (same rule as
 * `resolveButtonAck`): turning the guard OFF (`on === true`, i.e. enabling
 * blanket approval) happens only after Discord has ACKNOWLEDGED the warning, so
 * a failed reply can never leave a session silently unguarded. Turning YOLO off
 * is applied FIRST, because failing to confirm that must still be safe.
 *
 * Interaction handlers run concurrently, so the deferred enable is also FENCED:
 * the toggle epoch is snapshotted before the ack and the enable is dropped if
 * anything toggled meanwhile. Without it, `/yolo on` (slow ack) racing a
 * `/yolo off` could land AFTER the off, leaving the operator staring at an "OFF"
 * confirmation while permissions are auto-approved.
 *
 * Returns whether YOLO ended up enabled by this call.
 */
export interface YoloControl {
  /** Current toggle epoch (bumped by every toggle). */
  epoch: () => number;
  /** Disable immediately (also bumps the epoch). */
  disable: () => void;
  /** Enable iff `epoch` is still current; returns whether it applied. */
  enableIfCurrent: (epoch: number) => boolean;
}

export async function applyYoloToggle(
  on: boolean,
  ack: () => Promise<unknown>,
  ctl: YoloControl
): Promise<boolean> {
  if (!on) {
    ctl.disable(); // safe direction: apply immediately, confirm best-effort
    await ack().catch(() => {});
    return false;
  }
  const epoch = ctl.epoch(); // snapshot BEFORE awaiting Discord
  await ack(); // throws ⇒ YOLO stays OFF (fail-safe)
  return ctl.enableIfCurrent(epoch); // superseded by a later toggle ⇒ no-op
}

/**
 * Composition root: owns the single-instance lock, the Copilot SDK client, the
 * Discord gateway connection, and the per-thread SessionActor map. Wires the
 * three input surfaces (slash commands, thread messages, permission buttons)
 * through the auth gate to the orchestration core, and shuts everything down in
 * reverse order (lock released last).
 */
export class DiscordCopilotApp {
  private readonly discord: Client;
  private readonly transport: Transport;
  private readonly sessions = new Map<string, Session>();
  private readonly policy: AuthPolicy;
  /** Shared approval memory (session + persisted repo rules) across sessions. */
  private readonly approvals = new ApprovalPolicy();
  private modelIds: string[] = [];
  private readonly modelEfforts = new Map<string, string[]>();
  private shuttingDown = false;
  /** Threads already told their session is spent, so the courtesy notice is
   *  posted once rather than on every message. Volatile: a restart may repeat it
   *  once, which is harmless. */
  private readonly endedHinted = new Set<string>();
  /** Serializes /new so two near-simultaneous creations can't both pass the
   *  "one live session" teardown and leave two live sessions. */
  private creating = false;
  /** Durable thread↔session record for crash-safe resume (P2). */
  private readonly store: SessionStore;
  /** Startup phase gate (P2): input is rejected until reconciliation completes,
   *  so a /new can't race startup resume and create a second live actor. */
  private phase: "booting" | "reconciling" | "ready" | "shuttingDown" = "booting";

  private constructor(
    private readonly config: Config,
    private readonly repoPath: string,
    private readonly copilot: CopilotClient,
    private readonly lock: InstanceLock,
    transportOverride?: Transport,
    storeOverride?: SessionStore
  ) {
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.transport = transportOverride ?? new DiscordTransport(this.discord);
    this.store = storeOverride ?? new SessionStore(sessionStorePath());
    this.policy = {
      allowedUserIds: new Set(this.config.DISCORD_ALLOWED_USER_IDS),
      guildId: this.config.DISCORD_GUILD_ID,
      parentChannelId: this.config.DISCORD_PARENT_CHANNEL_ID,
    };
  }

  /** Test-only seam: construct the app with an injected transport + store (and
   *  fake copilot/lock), skipping the lock/SDK/login startup, so unit tests can
   *  drive the real runTurn/stop/reconcile wiring without a live Discord
   *  connection. Not used in production (start() is the only production entry). */
  static createForTest(
    config: Config,
    repoPath: string,
    copilot: CopilotClient,
    transport: Transport,
    store?: SessionStore
  ): DiscordCopilotApp {
    const noopLock: InstanceLock = { path: "(test)", release: async () => {} };
    return new DiscordCopilotApp(config, repoPath, copilot, noopLock, transport, store);
  }

  /** Build and fully start the app (lock → SDK → Discord login + commands). */
  static async start(config: Config): Promise<DiscordCopilotApp> {
    const repoPath = resolveControlledRepo(config.CONTROLLED_REPO_PATH);
    const compat = checkSdkCompat();
    if (!compat.ok) {
      // Fatal in bot mode: our event-field and permission-shape assumptions are
      // pinned to the declared SDK version; a mismatch could silently break
      // streaming or, worse, permission handling.
      throw new Error(
        `Installed @github/copilot-sdk ${compat.installed} != declared ${compat.declared}. ` +
          `Refusing to start the bot; run \`npm install\` to align.`
      );
    }
    const lock = await acquireSingleInstanceLock(lockPath());
    let copilot: CopilotClient | undefined;
    let app: DiscordCopilotApp | undefined;
    try {
      copilot = createCopilotClient({ workingDirectory: repoPath });
      await copilot.start();
      await preflightModel(copilot, config.DEFAULT_MODEL);
      app = new DiscordCopilotApp(config, repoPath, copilot, lock);
      await app.login();
      return app;
    } catch (err) {
      // Full teardown on any startup failure. If the app was constructed, its
      // stop() also destroys the (possibly logged-in) Discord client — so a
      // registration failure after gateway-ready doesn't leak a connection.
      if (app) await app.stop().catch(() => {});
      else {
        if (copilot) await copilot.stop().catch(() => {});
        await lock.release().catch(() => {});
      }
      throw err;
    }
  }

  /** Log in and resolve only once the gateway is ready AND slash commands are
   *  registered — so a registration failure fails startup (with cleanup) rather
   *  than leaving a logged-in bot with no usable commands. */
  private async login(): Promise<void> {
    this.discord.on(Events.InteractionCreate, (i) => void this.onInteraction(i));
    this.discord.on(Events.MessageCreate, (m) => void this.onMessage(m));
    this.installSignalHandlers();
    await new Promise<void>((resolve, reject) => {
      this.discord.once(Events.ClientReady, (c) => {
        this.onReady(c.user.id).then(resolve, reject);
      });
      this.discord.login(this.config.DISCORD_BOT_TOKEN).catch(reject);
    });
  }

  private async onReady(clientId: string): Promise<void> {
    await this.loadModels();
    await this.registerCommands(clientId);
    // Reconcile the persisted session BEFORE accepting input (phase gate), so a
    // /new can't race startup resume and leave two live actors on the shared tree.
    this.phase = "reconciling";
    await this.reconcileOnStartup();
    this.phase = "ready";
    console.log(
      `✅ discord-copilot-sdk ready — controlling ${this.repoPath}\n` +
        `   guild=${this.config.DISCORD_GUILD_ID} channel=${this.config.DISCORD_PARENT_CHANNEL_ID}\n` +
        `   model=${this.config.DEFAULT_MODEL} contextTier=${this.config.DEFAULT_CONTEXT_TIER} (${this.modelIds.length} models)\n` +
        `   ⚠️  lab mode: tools run as this OS user with no sandbox. The bot uses your\n` +
        `      logged-in Copilot, so any saved "always allow" rules bypass the Discord prompt.`
    );
  }

  /** Snapshot the available models + their supported reasoning efforts for the
   *  /model and /effort commands (choices are static once registered). */
  private async loadModels(): Promise<void> {
    try {
      const models = await this.copilot.listModels();
      this.modelIds = models.map((m) => m.id).slice(0, 25);
      for (const m of models) {
        // Store EVERY listed model. Empty array (or absent, per the SDK contract
        // "only present if the model supports reasoning effort") = known "no
        // effort support". A MISSING map entry means the model wasn't in the
        // snapshot at all — which must NOT be treated as unsupported. This
        // three-state distinction gates effort validation in cmdReconfigure.
        const raw = m.supportedReasoningEfforts as string[] | undefined;
        this.modelEfforts.set(m.id, Array.isArray(raw) ? raw : []);
      }
    } catch (err) {
      console.warn(`⚠️  could not list models for /model choices: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async registerCommands(clientId: string): Promise<void> {
    const modelChoices = this.modelIds.slice(0, 25).map((id) => ({ name: id, value: id }));
    const commands = [
      new SlashCommandBuilder()
        .setName("new")
        .setDescription("Start a new Copilot session in a thread")
        .addStringOption((o) =>
          o.setName("prompt").setDescription("Optional first prompt").setRequired(false)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Abort the current turn in this session thread")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Switch this session's model (history preserved)")
        .addStringOption((o) => {
          o.setName("id").setDescription("Model id").setRequired(true);
          if (modelChoices.length) o.addChoices(...modelChoices);
          return o;
        })
        .toJSON(),
      new SlashCommandBuilder()
        .setName("effort")
        .setDescription("Set this session's reasoning effort")
        .addStringOption((o) =>
          o
            .setName("level")
            .setDescription("Reasoning effort (validated against the current model)")
            .setRequired(true)
            .addChoices(...EFFORT_LEVELS.map((l) => ({ name: l, value: l })))
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("context")
        .setDescription("Set this session's context window tier")
        .addStringOption((o) =>
          o
            .setName("tier")
            .setDescription("Context tier")
            .setRequired(true)
            .addChoices(
              { name: "default", value: "default" },
              { name: "long_context", value: "long_context" }
            )
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("usage")
        .setDescription("Show this session's token usage")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("approvals")
        .setDescription("List (or clear) remembered command approvals")
        .addBooleanOption((o) =>
          o.setName("clear").setDescription("Clear this session + repo approvals").setRequired(false)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("diff")
        .setDescription("Show a git diff summary of the controlled repo")
        .addBooleanOption((o) =>
          o.setName("staged").setDescription("Show staged (--cached) changes instead").setRequired(false)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("todos")
        .setDescription("Show the agent's current todo checklist")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("yolo")
        .setDescription("⚠️ Auto-approve EVERY permission in this session (no prompts)")
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Turn blanket auto-approval on or off")
            .setRequired(true)
            .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("rename")
        .setDescription("Rename this session thread")
        .addStringOption((o) =>
          o.setName("title").setDescription("New title for this thread").setRequired(true)
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Queue a prompt to run after the current turn (a plain message steers instead)")
        .addStringOption((o) =>
          o.setName("message").setDescription("Prompt to run next").setRequired(false)
        )
        .addBooleanOption((o) =>
          o.setName("clear").setDescription("Discard everything currently queued").setRequired(false)
        )
        .toJSON(),
    ];
    // Register in the AUTHORIZED guild so command availability matches the auth
    // policy (DEV_GUILD_ID is intentionally not used here to avoid registering
    // where auth would reject).
    const rest = new REST({ version: "10" }).setToken(this.config.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(clientId, this.config.DISCORD_GUILD_ID), {
      body: commands,
    });
  }

  // ---- input surface: interactions (slash + buttons) --------------------

  private async onInteraction(interaction: Interaction): Promise<void> {
    try {
      // Startup gate (P2): reject input until reconciliation finished, so a /new
      // can't race startup resume. Also blocks during shutdown.
      if (this.phase !== "ready") {
        if (interaction.isRepliable()) {
          await interaction
            .reply({ content: "⏳ 啟動中，請稍候重試。", flags: MessageFlags.Ephemeral })
            .catch(() => {});
        }
        return;
      }
      if (interaction.isButton()) {
        await this.onButton(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        const c = interaction.commandName;
        if (c === "new") await this.cmdNew(interaction);
        else if (c === "stop") await this.cmdStop(interaction);
        else if (c === "model" || c === "effort" || c === "context") await this.cmdReconfigure(interaction);
        else if (c === "usage") await this.cmdUsage(interaction);
        else if (c === "approvals") await this.cmdApprovals(interaction);
        else if (c === "diff") await this.cmdDiff(interaction);
        else if (c === "todos") await this.cmdTodos(interaction);
        else if (c === "yolo") await this.cmdYolo(interaction);
        else if (c === "rename") await this.cmdRename(interaction);
        else if (c === "queue") await this.cmdQueue(interaction);
      }
    } catch (err) {
      console.error("interaction error:", err);
    }
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const perm = decodePermissionId(interaction.customId);
    const choice = perm ? undefined : decodeChoiceId(interaction.customId);
    const plan = perm || choice ? undefined : decodePlanId(interaction.customId);
    if (!perm && !choice && !plan) return; // not one of ours
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const uid = interaction.user.id;
    const nonce = perm?.nonce ?? choice?.nonce ?? plan?.nonce ?? "";
    // Unknown nonce (P2): the broker has no entry for it. That is execution-safe
    // (settle would no-op) but it is NOT only the restart case — the same state
    // is reached by the 5-minute timeout, by /stop (which settles pending cards
    // while leaving the buttons visibly intact), and by a /new that tore the old
    // session down. Name all of them rather than asserting a restart that
    // usually didn't happen.
    const pending = this.pendingFor(nonce);
    if (!pending) {
      await interaction
        .reply({
          content:
            "此互動已失效（可能因逾時、/stop、開新 session 或 bot 重啟），未執行任何動作。請重新操作。",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    // Cross-thread guard (§9: "跨 thread 點擊無法 resolve"). A card's buttons only
    // exist in its OWNING thread, so a decision must come from that thread. The
    // nonce is unique + Discord-validated, but bind it to the channel anyway as
    // defense-in-depth: a click whose channel ≠ the nonce's session never settles.
    if (!decisionBindsToChannel(pending, interaction.channelId)) {
      await interaction
        .reply({ content: "此互動不屬於目前的討論串，未執行任何動作。", flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    if (perm) {
      // Ack Discord BEFORE settling, so an Allow can never run while the user
      // sees "interaction failed"; ack failure delivers the safe default (deny).
      await resolveButtonAck(
        () => interaction.update({ components: [] }),
        (d) => this.transport.deliverDecision(perm.nonce, d, uid),
        perm.action
      );
      return;
    }
    // choice/plan: ack first, then settle on success.
    let acked = true;
    try {
      await interaction.update({ components: [] });
    } catch {
      acked = false;
    }
    if (choice) {
      // ack failure ⇒ leave the ask pending; it times out to the safe default.
      if (acked) this.transport.deliverChoice(choice.nonce, choice.index, uid);
    } else if (plan) {
      // ack failure ⇒ safe default is reject.
      this.transport.deliverPlan(plan.nonce, acked ? plan.action : "reject", uid);
    }
  }

  /** The pending view for `nonce` from whichever live session's broker owns it,
   *  or undefined if no live broker has it (e.g. a pre-restart card). Used both
   *  to reject expired nonces and to bind a decision to its owning thread. */
  private pendingFor(nonce: string): PendingView | undefined {
    if (!nonce) return undefined;
    for (const s of this.sessions.values()) {
      const v = s.broker.get(nonce);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  private async cmdNew(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.channelId !== this.config.DISCORD_PARENT_CHANNEL_ID) {
      await interaction.reply({
        content: "Run /new in the configured parent channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (this.creating) {
      await interaction.editReply("A session is already being created — please retry in a moment.");
      return;
    }
    this.creating = true;
    try {
      const parent = await this.discord.channels.fetch(this.config.DISCORD_PARENT_CHANNEL_ID);
      if (!parent || parent.type !== ChannelType.GuildText) {
        await interaction.editReply("Parent channel is not a text channel.");
        return;
      }

      // Name the thread from its first prompt when /new already carries one;
      // otherwise a timestamp holds the slot until the first message arrives.
      // No ordinal prefix: Discord orders a channel's threads by creation
      // (verified live 2026-07-28), so a number would only eat sidebar width.
      const promptOption = interaction.options.getString("prompt");
      const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
      const threadName = (promptOption ? deriveThreadTitle(promptOption) : "") || `copilot ${stamp}`;

      const thread = await (parent as TextChannel).threads.create({
        name: threadName.slice(0, THREAD_NAME_MAX),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      // Best-effort cleanup of the just-created thread on any abort path below,
      // so a failed /new doesn't litter empty threads.
      const dropThread = async (): Promise<void> => {
        await (thread as unknown as { delete?: () => Promise<unknown> }).delete?.().catch(() => {});
      };

      // Reserve-before-create (P2): durably record a `creating` row with a
      // caller-assigned session id BEFORE tearing down the old session or calling
      // createSession. This OVERWRITES any prior record, so a crash anywhere after
      // this point can never resurrect the superseded session (startup sees
      // `creating(newId)`, not the old `active` row). Capture the prior record so
      // a FAILED (non-crash) teardown can be rolled back, keeping the live old
      // session fully intact.
      const prevRecord = this.store.get();
      const sessionId = randomUUID();
      const generation = this.store.nextGeneration();
      const reserved = this.store.reserve({
        threadId: thread.id,
        sessionId,
        generation,
        repoPath: this.repoPath,
        guildId: this.config.DISCORD_GUILD_ID,
        parentChannelId: this.config.DISCORD_PARENT_CHANNEL_ID,
      });
      if (!reserved) {
        await dropThread();
        await interaction.editReply(
          "⚠️ 無法持久化 session 狀態（寫入磁碟失敗），未建立新的 session。請檢查磁碟／權限後重試。"
        );
        return;
      }

      // v1 runs ONE live session at a time: all sessions share the single
      // controlled working tree, so two concurrent agents could clobber each
      // other's checkout/edits. Refuse to start if the previous one won't end.
      const ended = await this.endAllSessions("A new session was started; this one has ended.");
      if (!ended) {
        // Teardown failed and the old actor is still live in-memory (endAllSessions
        // retains it → it also FENCES the next /new). Roll the record back to the
        // still-live old session so disk and memory agree and it stays resumable.
        const rolledBack = prevRecord ? this.store.restore(prevRecord) : this.store.clear();
        await dropThread();
        await interaction.editReply(
          rolledBack
            ? "無法結束前一個 session（可能已失效），未建立新的。前一個 session 已保留——請重試；若持續發生請重啟 bot。"
            : "⚠️ 無法結束前一個 session，且回滾記錄也失敗（磁碟問題）。前一個 session 仍在執行中，但其記錄可能不一致——請重啟 bot。"
        );
        return;
      }

      const broker = new PendingInteractionBroker();
      let actor: SessionActor;
      try {
        actor = await SessionActor.create(this.copilot, {
          sessionKey: thread.id,
          workingDirectory: this.repoPath,
          model: this.config.DEFAULT_MODEL,
          contextTier: this.config.DEFAULT_CONTEXT_TIER,
          broker,
          transport: this.transport,
          policy: this.approvals,
          generation,
          createSessionId: sessionId,
        });
      } catch (err) {
        // Create failed after the old session was torn down. The RPC may or may
        // not have created the assigned id, so best-effort DELETE it to remove any
        // dormant runtime session (it has no actor and can never receive a turn,
        // so it can't contend for the tree, but we don't want it lingering). The
        // record stays `creating` (→ orphaned on restart, fail-closed); no live
        // actor exists, so /new can be retried.
        await withTimeout(
          ((this.copilot as unknown as { deleteSession?: (id: string) => Promise<unknown> }).deleteSession?.(
            sessionId
          ) ?? Promise.resolve()) as Promise<unknown>,
          TEARDOWN_TIMEOUT_MS
        ).catch(() => {});
        await dropThread();
        await interaction.editReply(
          `⚠️ 建立 session 失敗（${err instanceof Error ? err.message : String(err)}）。請重試 /new。`
        );
        return;
      }
      // Promote creating→active. A failed commit means the record isn't durable,
      // so we must NOT run as active. Try a bounded disconnect of the just-created
      // actor; if that fails the runtime may still be live, so RETAIN the actor as
      // a fence (registered) — endAllSessions will then refuse the next /new until
      // a restart, rather than letting a second live actor onto the shared tree.
      if (!this.store.commit()) {
        let disconnected = false;
        try {
          await withTimeout(actor.disconnect(), TEARDOWN_TIMEOUT_MS);
          disconnected = true;
        } catch {
          disconnected = false;
        }
        if (disconnected) {
          await dropThread();
          await interaction.editReply(
            "⚠️ 無法持久化 session 狀態（commit 失敗），已取消啟動。請檢查磁碟／權限後重試。"
          );
        } else {
          // Fence: keep the (maybe-live) actor registered so /new stays blocked.
          this.sessions.set(thread.id, { actor, broker, running: false, titled: true, titleEpoch: 0, queue: [] });
          await interaction.editReply(
            "⚠️ 無法持久化 session 狀態，且無法確認前述 runtime 已關閉。已將其設為屏障以避免雙重 session——請重啟 bot。"
          );
        }
        return;
      }
      const session: Session = { actor, broker, running: false, titled: false, titleEpoch: 0, queue: [] };
      this.sessions.set(thread.id, session);
      await interaction.editReply(`Started a session in <#${thread.id}>. Send prompts there.`);

      if (promptOption) {
        // Title this the same way a first thread message is titled — the thread
        // was created with the local heuristic so it is never nameless, and the
        // model's shorter name replaces it a few seconds later.
        this.startTitling(thread.id, session, promptOption);
        void this.runTurn(thread.id, promptOption).catch(() => {});
      }
    } finally {
      this.creating = false;
    }
  }

  /** Fire the one-shot thread titler for `text`, fenced so it can never run
   *  twice or overwrite a later `/rename`. Fire-and-forget by design: naming is
   *  cosmetic and must never delay or fail a turn. */
  private startTitling(threadId: string, session: Session, text: string): void {
    if (session.titled || !text) return;
    session.titled = true;
    const epoch = session.titleEpoch;
    void this.titleThreadFromFirstMessage(
      threadId,
      text,
      () => this.sessions.get(threadId) === session && session.titleEpoch === epoch
    ).catch(() => {});
  }

  /** Rename a session thread. Never throws: a rename is cosmetic and must not
   *  be able to fail a turn. Discord rate-limits channel renames, and discord.js
   *  queues rather than rejects, so this is always fire-and-forget from the turn
   *  path. */
  private async retitleThread(threadId: string, title: string): Promise<boolean> {
    if (!title) return false;
    try {
      const ch = await this.discord.channels.fetch(threadId);
      const thread = ch as unknown as { name?: string; setName?: (n: string) => Promise<unknown> };
      if (!thread?.setName) return false;
      const next = title.slice(0, THREAD_NAME_MAX);
      if (next === thread.name) return false;
      await thread.setName(next);
      return true;
    } catch (err) {
      console.warn(`⚠️  could not rename thread ${threadId}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * Name a thread from its first message, once.
   *
   * The title comes from a SMALL model in a THROWAWAY session — not from the
   * user's own session, which would pollute its history and burn its context —
   * because a raw first line makes a poor thread name: it is often far longer
   * than the sidebar shows, and the interesting part is rarely at the start.
   * The local heuristic remains the fallback for every failure path (model not
   * available, RPC error, timeout, junk reply), so a thread is never left
   * nameless and a turn is never blocked. Exactly ONE rename happens either way,
   * which keeps this clear of Discord's channel-rename rate limit.
   *
   * `epoch` fences the write: `/rename` bumps the session's title epoch, so an
   * explicit name the operator just chose can never be overwritten seconds later
   * by a titler that was already in flight.
   */
  private async titleThreadFromFirstMessage(
    threadId: string,
    firstMessage: string,
    isCurrent: () => boolean
  ): Promise<void> {
    const heuristic = deriveThreadTitle(firstMessage);
    const generated = await this.generateTitle(firstMessage);
    if (!isCurrent()) return; // superseded by /rename (or the session is gone)
    await this.retitleThread(threadId, generated || heuristic);
  }

  /** Ask a small model for a thread title. Returns "" on ANY failure — this is
   *  cosmetic and must never surface an error to the user. */
  private async generateTitle(firstMessage: string): Promise<string> {
    if (this.config.TITLE_MODEL === "off") return "";
    // Resolve against every model the runtime listed, NOT `modelIds` — that is
    // truncated to Discord's 25-choice cap for the /model command, so a title
    // model past index 24 would silently never be picked.
    const model = pickTitleModel([...this.modelEfforts.keys()], this.config.TITLE_MODEL);
    if (!model) return "";
    // `withTimeout` does not cancel the underlying call, and the SDK registers
    // the session in its client map before the create RPC — so a create that
    // lands AFTER we gave up would otherwise be live in the runtime with no
    // reference to it anywhere here (a permanent leak, once per timed-out
    // title). Attach the salvage ONLY on the timeout path: a flag checked inside
    // a handler attached up front is racy, because that handler runs before the
    // `await` continuation that would have set it — which disposes the session
    // the instant it is created.
    const creating = this.copilot.createSession({
      workingDirectory: this.repoPath,
      model,
      streaming: false,
      // The titler reads ONE string and must never touch the machine. Denying
      // permissions is NOT enough: only tools that ASK are stopped that way, and
      // the default (copilot-cli) tool set is ambient. `availableTools: []`
      // leaves it with no tools at all — verified against the runtime: 0 tool
      // invocations and 0 permission requests, vs glob/view/powershell by
      // default.
      availableTools: [],
      enableFileHooks: false,
      enableConfigDiscovery: false,
      enableSkills: false,
      skipCustomInstructions: true,
      onPermissionRequest: () => ({ kind: "user-not-available" }),
    } as never) as unknown as Promise<TitlerSession>;
    try {
      const session = await withTimeout(creating, TITLE_TIMEOUT_MS).catch((err: unknown) => {
        void creating.then(
          (s) => this.disposeTitler(s),
          () => {}
        );
        throw err;
      });
      try {
        let text = "";
        session.on("assistant.message", (e) => {
          const d = (e as { data?: Record<string, unknown> })?.data ?? {};
          const c = d["content"] ?? d["text"];
          if (typeof c === "string" && c.trim()) text = c;
        });
        const idle = new Promise<void>((resolve) => session.on("session.idle", () => resolve()));
        await session.send({ prompt: buildTitlePrompt(firstMessage) });
        await withTimeout(idle, TITLE_TIMEOUT_MS);
        return cleanModelTitle(text);
      } finally {
        await this.disposeTitler(session);
      }
    } catch (err) {
      console.warn(`⚠️  title model failed: ${err instanceof Error ? err.message : err}`);
      return "";
    }
  }

  /** Tear a throwaway titler session down: disconnect (releases handlers and
   *  stops any still-running turn) then delete it from the runtime's session
   *  list. Both bounded, both best effort — a titler must never be able to stall
   *  or fail anything. */
  private async disposeTitler(session: TitlerSession): Promise<void> {
    await withTimeout(session.disconnect?.() ?? Promise.resolve(), TEARDOWN_TIMEOUT_MS).catch(() => {});
    const id = session.sessionId;
    if (!id) return;
    await withTimeout(
      ((this.copilot as unknown as { deleteSession?: (i: string) => Promise<unknown> }).deleteSession?.(id) ??
        Promise.resolve()) as Promise<unknown>,
      TEARDOWN_TIMEOUT_MS
    ).catch(() => {});
  }

  /** Reconcile the persisted session on startup (P2). Runs while `phase` is
   *  "reconciling" (input rejected), so it can register a resumed session before
   *  any /new. `deps.classifyThread` is injectable for tests. Throws on a corrupt
   *  store so startup fails closed rather than silently starting fresh. */
  private async reconcileOnStartup(deps?: {
    classifyThread?: (threadId: string) => Promise<ThreadStatus>;
  }): Promise<void> {
    const classify = deps?.classifyThread ?? ((id: string) => this.classifyThread(id));
    const rec = this.store.get();
    const corrupt = this.store.isCorrupt();

    let bindingOk: boolean | undefined;
    let threadStatus: ThreadStatus | undefined;
    if (!corrupt && rec?.state === "active") {
      bindingOk = this.bindingOk(rec);
      if (bindingOk) threadStatus = await classify(rec.threadId);
    }

    const action = planReconcile({ corrupt, state: rec?.state, bindingOk, threadStatus });
    switch (action.kind) {
      case "fail-corrupt":
        throw new Error(
          `session store at ${sessionStorePath()} is corrupt; refusing to start. Inspect/remove it and restart.`
        );
      case "fresh":
      case "retain":
        return;
      case "orphan-interrupted":
        // A required terminal transition: if it can't be persisted, that's a disk
        // problem — fail startup rather than run with a non-durable state.
        if (!this.store.setState("orphaned", "interrupted-create")) {
          throw new Error(`reconcile: could not persist orphaned state at ${sessionStorePath()}`);
        }
        return;
      case "skip":
        console.warn(`reconcile: not resuming this boot (${action.reason}); record left unchanged.`);
        if (rec) {
          await this.transport
            .notice(
              rec.threadId,
              "⚠️ 啟動時暫時無法確認此執行緒狀態，本次未復原。session 記錄已保留——重新啟動 bot 可再嘗試。"
            )
            .catch(() => {});
        }
        return;
      case "block":
        if (!this.store.setState("blocked", action.reason)) {
          throw new Error(`reconcile: could not persist blocked state at ${sessionStorePath()}`);
        }
        if (rec) {
          await this.transport
            .notice(rec.threadId, `⚠️ 無法復原此 session（${action.reason}）。請用 /new 開新的。`)
            .catch(() => {});
        }
        return;
      case "resume":
        if (rec) await this.resumeRecord(rec);
        return;
    }
  }

  /** Resume the SDK session for an active record; register it and post an honest
   *  recovery notice. A resume failure is classified session-lost (definitive →
   *  orphaned, terminal) vs transient (record LEFT ACTIVE so a later restart
   *  retries — never dropping recoverable history). */
  private async resumeRecord(rec: SessionRecord): Promise<void> {
    const broker = new PendingInteractionBroker();
    let actor: SessionActor;
    try {
      actor = await SessionActor.create(this.copilot, {
        sessionKey: rec.threadId,
        workingDirectory: this.repoPath,
        model: this.config.DEFAULT_MODEL,
        contextTier: this.config.DEFAULT_CONTEXT_TIER,
        broker,
        transport: this.transport,
        policy: this.approvals,
        generation: rec.generation,
        resumeSessionId: rec.sessionId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (classifyResumeError(msg) === "session-lost") {
        // Definitive: the session id is gone. Mark terminal; a failed persist of
        // that transition is a disk problem we must surface (fail startup).
        if (!this.store.setState("orphaned", "session-lost")) {
          throw new Error(`reconcile: could not persist orphaned state for ${rec.threadId}`);
        }
        await this.transport
          .notice(rec.threadId, "⚠️ 無法復原（session 已遺失）。請用 /new 開新的。")
          .catch(() => {});
      } else {
        // Transient (network/RPC/unknown): leave the record ACTIVE so the next
        // restart retries. Do NOT lie that it's blocked. The thread is un-resumed
        // for THIS boot; the bot still comes up so /new remains usable.
        console.warn(`reconcile: transient resume failure for ${rec.threadId}: ${msg}`);
        await this.transport
          .notice(
            rec.threadId,
            `⚠️ 暫時無法復原此對話（${msg}）。session 記錄已保留——重新啟動 bot 可再嘗試復原；或用 /new 重新開始。`
          )
          .catch(() => {});
      }
      return;
    }
    // A resumed thread was already named by the run that created it — never
    // re-title it from whatever the user happens to type first after a restart.
    this.sessions.set(rec.threadId, { actor, broker, running: false, titled: true, titleEpoch: 0, queue: [] });
    this.store.commit(); // keep active, refresh updatedAt
    await this.transport
      .notice(
        rec.threadId,
        "♻️ 已從重啟復原此對話（歷史保留）。上一個回合已中斷且**不會自動續跑**；" +
          "先前若有指令可能已部分或完全執行，請先確認 repo／程序狀態，再決定是否重送。" +
          "\n🛡️ YOLO 模式已重置為 **OFF**（不會跨重啟保留）。"
      )
      .catch(() => {});
  }

  /** Whether the stored binding still matches this bot's config + controlled repo.
   *  A mismatch (e.g. CONTROLLED_REPO_PATH or guild/parent changed between runs)
   *  must NOT resume — it would run one repo's conversation against another. */
  private bindingOk(rec: SessionRecord): boolean {
    const norm = (p: string): string => p.replace(/[\\/]+$/, "").toLowerCase();
    return (
      norm(rec.repoPath) === norm(this.repoPath) &&
      rec.guildId === this.config.DISCORD_GUILD_ID &&
      rec.parentChannelId === this.config.DISCORD_PARENT_CHANNEL_ID
    );
  }

  /** Classify the Discord thread a record is bound to. Distinguishes definitive
   *  absence/inaccessibility from a transient fetch failure so a startup blip
   *  can't drop a recoverable session. Unarchives an archived thread if possible. */
  private async classifyThread(threadId: string): Promise<ThreadStatus> {
    let ch;
    try {
      ch = await this.discord.channels.fetch(threadId);
    } catch (err) {
      const e = err as { code?: number; status?: number };
      if (e?.code === 10003) return "gone"; // Unknown Channel (definitive 404)
      if (e?.status === 403 || e?.code === 50001) return "inaccessible"; // Missing Access
      return "transient"; // 429 / 5xx / network / unknown — retryable
    }
    if (!ch) return "gone";
    const anyCh = ch as unknown as {
      isThread?: () => boolean;
      guildId?: string;
      parentId?: string | null;
      archived?: boolean | null;
      setArchived?: (v: boolean) => Promise<unknown>;
      sendable?: boolean;
    };
    if (typeof anyCh.isThread === "function" && !anyCh.isThread()) return "inaccessible";
    if (anyCh.guildId !== this.config.DISCORD_GUILD_ID) return "inaccessible";
    if (anyCh.parentId !== this.config.DISCORD_PARENT_CHANNEL_ID) return "inaccessible";
    if (anyCh.archived) {
      try {
        await anyCh.setArchived?.(false);
      } catch {
        return "archived-unarchivable";
      }
    }
    if (typeof anyCh.sendable === "boolean" && !anyCh.sendable) return "archived-unarchivable";
    return "valid";
  }

  private async cmdStop(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "No active session in this thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Cancel a turn that's still reserved but not yet sent (e.g. downloading an
    // image), then stop any in-flight SDK turn. Both are safe/idempotent.
    // Defer BEFORE the abort: it is a JSON-RPC round trip to a runtime that may
    // be wedged, and this is the one command that has to work precisely then.
    // Without the defer a >3s abort expires the interaction token and the
    // operator sees "the application did not respond" with no idea whether the
    // abort landed.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Drop anything queued FIRST, so a slow abort can't let drainQueue start the
    // next prompt while the operator is watching this one stop. "Stop" has to
    // mean the session goes quiet, not "stop this one and start the next".
    const dropped = session.queue.length;
    session.queue = [];
    const ok = await this.stopSession(session);
    const tail = dropped ? ` 已同時丟棄佇列中的 ${dropped} 則。` : "";
    await interaction.editReply({
      content:
        (ok ? "Abort requested for the current turn." : "Abort attempted but the runtime reported an error.") +
        tail,
    });
  }

  /** The core of /stop: abort a still-reserved (pre-send) turn so an in-flight
   *  attachment download is cancelled and never reaches the agent, then stop any
   *  live SDK turn. Extracted so the /stop wiring is unit-testable end to end. */
  private async stopSession(session: Session): Promise<boolean> {
    session.currentAbort?.abort();
    return session.actor.stop();
  }

  /** /model, /effort, /context — reconfigure the current thread's session. */
  private async cmdReconfigure(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "Run this inside a session thread (start one with /new).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const change: { model?: string; effort?: string; context?: "default" | "long_context"; resetEffort?: boolean } = {};
    const cur = session.actor.config();
    if (interaction.commandName === "model") {
      const id = interaction.options.getString("id", true);
      if (this.modelIds.length && !this.modelIds.includes(id)) {
        await interaction.reply({ content: `Unknown model \`${id}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }
      change.model = id;
      // If the new model doesn't support the currently-set effort, drop it rather
      // than sending an unsupported effort the runtime would reject. Unknown
      // model (not in snapshot) leaves the effort untouched.
      if (shouldResetEffort(cur.effort, this.modelEfforts.get(id))) {
        change.resetEffort = true;
      }
    } else if (interaction.commandName === "effort") {
      const level = interaction.options.getString("level", true);
      const check = validateEffort(cur.model, level, this.modelEfforts.get(cur.model ?? ""));
      if (!check.ok) {
        await interaction.reply({ content: check.message, flags: MessageFlags.Ephemeral });
        return;
      }
      change.effort = level;
    } else {
      change.context = interaction.options.getString("tier", true) as "default" | "long_context";
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await session.actor.reconfigure(change);
      const c = session.actor.config();
      await interaction.editReply(
        `Updated. model=\`${c.model ?? "?"}\` effort=\`${c.effort ?? "default"}\` context=\`${c.context ?? "default"}\` (takes effect next message).`
      );
    } catch (err) {
      await interaction.editReply(`Could not update: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cmdUsage(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "Run this inside a session thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Report the RUNTIME's view, not what discord-copilot-sdk asked for. Echoing the local
    // cache made /usage useless as evidence: after a resume it would show this
    // process's startup defaults, and a setModel that the runtime quietly
    // ignored would still read back as applied. Falls back to the cache when the
    // RPC is unavailable.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await session.actor.syncConfigFromRuntime();
    const u = session.actor.usage();
    const c = session.actor.config();
    const yolo = session.actor.isYolo() ? "\n⚡ **YOLO: ON** — every permission is auto-approved (`/yolo mode:off`)" : "";
    // `effort` is genuinely UNSET on most sessions (the runtime picks per model);
    // calling that "default" invited reading it as a level named "default".
    const header = `model=\`${c.model ?? "?"}\` effort=\`${c.effort ?? "(unset)"}\` context=\`${c.context ?? "default"}\``;
    const pct = u && u.tokenLimit > 0 ? Math.round((u.currentTokens / u.tokenLimit) * 100) : undefined;
    const body = u
      ? `\ntokens: ${u.currentTokens.toLocaleString()} / ${u.tokenLimit.toLocaleString()}${pct !== undefined ? ` (${pct}%)` : ""}`
      : "\n(no usage reported yet — send a message first)";
    await interaction.editReply({ content: header + body + yolo });
  }

  /** `/yolo on|off` — blanket permission auto-approval for THIS session.
   *
   *  Safety ordering mirrors the ack-before-allow invariant used for buttons:
   *  turning YOLO **on** happens only AFTER Discord has acknowledged the reply,
   *  so a failed reply can never leave the session silently unguarded. Turning
   *  it **off** happens FIRST, because a failure there must still be safe. */
  private async cmdYolo(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: "Run this inside a session thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const on = interaction.options.getString("mode", true) === "on";
    const warning =
      "⚠️ **YOLO ON for this thread** — every permission request is auto-approved with **no prompt**, " +
      "including file writes and other kinds that are normally refused. Tools run as your OS user with no sandbox.\n" +
      "• Any approval card already waiting still needs your decision.\n" +
      "• This is **not** persisted: a restart or session recovery resets it to OFF.\n" +
      "• Turn it off with `/yolo mode:off`.";
    await applyYoloToggle(
      on,
      () =>
        interaction.reply({
          content: on ? warning : "🛡️ YOLO **OFF** — permissions will prompt again.",
          flags: MessageFlags.Ephemeral,
        }),
      {
        epoch: () => session.actor.yoloEpochValue(),
        disable: () => session.actor.setYolo(false),
        enableIfCurrent: (e) => session.actor.enableYoloIfCurrent(e),
      }
    ).then(async (enabled) => {
      // Only announce when the enable actually took effect (a concurrent
      // `/yolo off` may have superseded it).
      if (enabled) {
        await this.transport
          .notice(interaction.channelId, "⚡ **YOLO mode ON** — permissions are now auto-approved for this session.")
          .catch(() => {});
      }
    });
  }

  private async cmdApprovals(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const clear = interaction.options.getBoolean("clear") ?? false;
    // Act on every LIVE session, not just this channel — /approvals is usable
    // from the parent channel, where scoping to the channel silently skipped the
    // in-memory rules while still claiming they were revoked.
    const scope = approvalScopeKeys(this.sessions.keys());
    const sessionRules = [...new Set(scope.flatMap((k) => this.approvals.sessionApprovals(k)))];
    const repoRules = this.approvals.repoApprovals(this.repoPath);
    if (clear) {
      for (const key of scope) this.approvals.clearSession(key);
      const durable = this.approvals.clearRepo(this.repoPath);
      const tail = durable
        ? "Future commands will prompt again."
        : "⚠️ 已在記憶體中清除（本次執行不會再自動核准），但寫入磁碟失敗 — 重啟後 repo 規則可能重現，請檢查檔案權限。";
      await interaction.reply({
        content:
          `Cleared approvals — session: ${fmtList(sessionRules)} · repo: ${fmtList(repoRules)}. ` + tail,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `Approved (auto-run, no prompt):\n• session: ${fmtList(sessionRules)}\n• this repo: ${fmtList(repoRules)}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async cmdDiff(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const staged = interaction.options.getBoolean("staged") ?? false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const summary = await gitDiffSummary(this.repoPath, staged);
      await interaction.editReply({ content: summary });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ 無法取得 git diff：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async cmdTodos(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({ content: "Run this inside a session thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rows = await session.actor.readTodos();
    if (rows === undefined) {
      // Distinguish "the read failed" from "there are none" — reporting a broken
      // read as an empty list hides the failure behind a plausible answer.
      await interaction.editReply({ content: "⚠️ 無法讀取待辦清單（session 尚未建立 plan 資料或 RPC 失敗）。" });
      return;
    }
    const rendered = formatTodos(rows);
    await interaction.editReply({ content: (rendered || "目前沒有待辦事項。").slice(0, 1900) });
  }

  /** /rename — retitle the current session thread. */
  private async cmdRename(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({ content: "Run this inside a session thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const title = deriveThreadTitle(interaction.options.getString("title") ?? "");
    if (!title) {
      await interaction.reply({ content: "標題是空的（或只有符號），沒有改名。", flags: MessageFlags.Ephemeral });
      return;
    }
    // Discord queues renames behind its channel-update bucket, so this can take
    // noticeably longer than the 3s interaction token allows.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ok = await this.retitleThread(interaction.channelId, title);
    // An explicit rename also counts as "titled" either way, so a later first
    // message can't silently overwrite what the operator just chose — and the
    // epoch bump invalidates a titler that is ALREADY in flight, which would
    // otherwise land seconds later and undo this.
    session.titled = true;
    session.titleEpoch++;
    await interaction.editReply({
      content: ok ? `已改名為 **${title}**。` : "⚠️ 改名失敗（權限或 Discord 速率限制）。稍後再試。",
    });
  }

  /**
   * `/queue` — hold a prompt until the current turn finishes.
   *
   * The queue lives HERE, not in the runtime. The SDK does offer
   * `send({mode:"enqueue"})`, but `session.abort()` does NOT drain the runtime's
   * queue (verified: a queued message still ran after an abort), which would
   * make `/stop` a lie. Holding it locally keeps "stop means stop".
   *
   * Volatile by design, like YOLO: a restart drops the queue rather than
   * resurrecting work the operator has long forgotten about.
   */
  private async cmdQueue(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.sessions.get(interaction.channelId);
    if (!session) {
      await interaction.reply({ content: "Run this inside a session thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const reply = (content: string): Promise<unknown> =>
      interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (interaction.options.getBoolean("clear")) {
      const n = session.queue.length;
      session.queue = [];
      await reply(n ? `🗑️ 已清空佇列（丟棄 ${n} 則）。` : "佇列本來就是空的。");
      return;
    }
    const text = (interaction.options.getString("message") ?? "").trim();
    if (!text) {
      // No message + no clear = show what's pending.
      if (!session.queue.length) await reply("佇列是空的。用 `/queue message:…` 排入下一則。");
      else {
        const list = session.queue.map((q, i) => `${i + 1}. ${q.slice(0, 120)}`).join("\n");
        await reply(`📋 佇列中的 ${session.queue.length} 則（重啟不保留）：\n${list}`.slice(0, 1900));
      }
      return;
    }
    if (session.queue.length >= QUEUE_MAX) {
      await reply(`⚠️ 佇列已滿（上限 ${QUEUE_MAX} 則）。先讓它跑完，或用 \`/queue clear:true\` 清空。`);
      return;
    }
    session.queue.push(text);
    if (!session.running) {
      // Nothing to wait for — reply first (the interaction token is short), then
      // start it. drainQueue is the single place a queued item is consumed.
      await reply("▶️ 目前沒有在執行，直接開始這一則。");
      void this.drainQueue(interaction.channelId).catch(() => {});
      return;
    }
    await reply(`📥 已排入佇列（第 ${session.queue.length} 位，會在目前回合結束後執行）。`);
  }

  // ---- input surface: thread messages -----------------------------------

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const session = this.sessions.get(message.channelId);
    if (!session) {
      await this.hintEndedSession(message);
      return; // not a live session thread
    }
    if (!isAuthorized(ctxOf(message), this.policy)) return; // silent for non-owners
    // Startup gate, checked AFTER the thread+author checks so it can never spam
    // unrelated channels. resumeRecord registers the session and posts its
    // recovery notice while `phase` is still "reconciling", so a user replying
    // to that notice immediately would otherwise have their prompt vanish with
    // no trace. Slash commands already answer with the same courtesy.
    if (this.phase !== "ready") {
      await this.transport
        .notice(message.channelId, "⏳ 啟動中（正在復原對話），請稍候重試。")
        .catch(() => {});
      return;
    }
    const text = message.content.trim();
    const hasAttachments = message.attachments.size > 0;
    // A pending freeform ask_user expects a TEXT answer. Route on the ORIGINAL
    // attachment presence (not download success) so a failed/oversized image
    // can't have its text silently answer the ask.
    if (!hasAttachments && text && session.actor.tryConsumeFreeform(text)) return;
    if (hasAttachments && session.actor.isAwaitingFreeform()) {
      await this.transport
        .notice(message.channelId, "⚠️ 正在等你回答上一個提問，請用文字回覆（圖片無法作為答案）。")
        .catch(() => {});
      return;
    }
    if (!text && !hasAttachments) {
      await this.transport.notice(
        message.channelId,
        "Empty message — is the Message Content intent enabled for this bot?"
      );
      return;
    }
    // Name the thread after its first real prompt, exactly once.
    this.startTitling(message.channelId, session, text);
    // Reserve the turn (via the running guard in runTurn) BEFORE any network I/O,
    // so image downloads serialize with message arrival and two quick image
    // messages can't reorder. The download happens inside runTurn.
    await this.runTurn(message.channelId, text, message);
  }

  /** Tell an authorized operator that the thread they just typed into is a spent
   *  session, instead of silently swallowing the message. Once per thread per
   *  process, and only in threads this bot opened under the configured parent —
   *  see `isOurEndedThread`. Never throws: this is a courtesy, not a feature. */
  private async hintEndedSession(message: Message): Promise<void> {
    try {
      if (this.endedHinted.has(message.channelId)) return;
      if (!isAuthorized(ctxOf(message), this.policy)) return; // silent for non-owners
      const ch = message.channel as unknown as {
        isThread?: () => boolean;
        parentId?: string | null;
        ownerId?: string | null;
      };
      const ours = isOurEndedThread({
        channelIsThread: ch.isThread?.() === true,
        threadParentId: ch.parentId ?? undefined,
        threadOwnerId: ch.ownerId ?? undefined,
        configuredParentChannelId: this.config.DISCORD_PARENT_CHANNEL_ID,
        botUserId: this.discord.user?.id,
      });
      if (!ours) return;
      this.endedHinted.add(message.channelId);
      await this.transport
        .notice(
          message.channelId,
          "💤 這個討論串的 session 已經結束（v1 一次只跑一個 session，後來的 `/new` 會接手），訊息不會送出。" +
            "請到最新的討論串繼續，或在父頻道用 `/new` 開一個新的。"
        )
        .catch(() => {});
    } catch {
      /* a courtesy notice must never affect message handling */
    }
  }

  /** Download a message's image attachments as base64 blobs for the SDK. Only
   *  image/* is accepted (P5 = images); non-images and over-limit files are
   *  skipped with a notice. Bounded by count, per-file size AND a cumulative
   *  total, with a fetch timeout and a streaming byte cap, so a huge or stalled
   *  upload can't blow the prompt budget or memory. */
  private async collectImageAttachments(message: Message, signal?: AbortSignal): Promise<BlobAttachment[]> {
    const MAX_IMAGES = 4;
    const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB per image
    const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // cap across all images in one message
    const all = [...message.attachments.values()];
    if (all.length === 0) return [];
    const out: BlobAttachment[] = [];
    let skipped = 0;
    let total = 0;
    for (const att of all) {
      if (signal?.aborted) break; // /stop during download: bail immediately
      if (out.length >= MAX_IMAGES) {
        skipped++;
        continue;
      }
      const mime = (att.contentType ?? "").split(";")[0]!.trim().toLowerCase();
      if (!mime.startsWith("image/")) {
        skipped++;
        continue;
      }
      // Cheap pre-check on Discord's declared size before any download.
      if (typeof att.size === "number" && att.size > MAX_BYTES) {
        skipped++;
        continue;
      }
      const remaining = Math.min(MAX_BYTES, MAX_TOTAL_BYTES - total);
      if (remaining <= 0) {
        skipped++;
        continue;
      }
      const buf = await downloadBounded(att.url, remaining, 15_000, signal);
      if (!buf) {
        skipped++;
        continue;
      }
      total += buf.byteLength;
      out.push({
        type: "blob",
        data: buf.toString("base64"),
        mimeType: mime,
        displayName: att.name ?? "image",
      });
    }
    // Suppress the skip notice on an abort — the turn is being cancelled anyway.
    if (skipped > 0 && !signal?.aborted) {
      await this.transport
        .notice(
          message.channelId,
          `ℹ️ 已略過 ${skipped} 個附件（僅支援圖片，每張上限 8MB、單則最多 ${MAX_IMAGES} 張且總量 24MB；下載逾時或失敗也會略過）。`
        )
        .catch(() => {});
    }
    return out;
  }

  /** Run one prompt to real completion (session.idle), guarding against
   *  overlapping sends per thread. `running` stays set for the WHOLE turn, so
   *  attachment downloads (done here, after the guard) serialize with arrival. */
  private async runTurn(threadId: string, text: string, message?: Message): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.actor.isFaulted()) {
      await this.transport.notice(
        threadId,
        "This session has faulted and can't accept more prompts. Start a new one with /new."
      );
      return;
    }
    if (session.running) {
      // A message arriving mid-turn STEERS the running turn rather than being
      // dropped. `mode: "immediate"` lands at the next tool boundary (measured:
      // a run of 8 sequential commands stopped after 4) and jumps ahead of
      // anything already queued; during a single long generation it runs
      // straight after instead, which is the best achievable without throwing
      // away in-flight work. Attachments are deliberately NOT downloaded here:
      // steering must be immediate, and a slow download would defeat the point.
      try {
        await session.actor.steer(text);
        await this.transport
          .notice(threadId, "↪️ 已插入目前回合（steer）。工具執行到下一個段落時才會轉向。")
          .catch(() => {});
      } catch (err) {
        await this.transport
          .notice(
            threadId,
            `⚠️ 無法插入目前回合（${err instanceof Error ? err.message : String(err)}）。` +
              "可用 `/queue` 排到這一輪之後，或 `/stop` 中止。"
          )
          .catch(() => {});
      }
      return;
    }
    session.running = true;
    const ac = new AbortController();
    session.currentAbort = ac;
    this.transport.resetTurn(threadId);
    try {
      const outcome = await sendUnlessAborted(
        ac.signal,
        // prepare: download attachments (may be slow) while /stop can still abort.
        async () => {
          const images = message ? await this.collectImageAttachments(message, ac.signal) : [];
          const prompt = text || (images.length ? "請看我附上的圖片。" : "");
          return { images, prompt };
        },
        // send: only reached when NOT aborted during the download above.
        async ({ images, prompt }) => {
          if (!prompt) {
            // Had attachments but none were usable, and there was no text to send.
            await this.transport
              .notice(threadId, "⚠️ 附件都無法使用（僅支援圖片），且訊息沒有文字，已略過。")
              .catch(() => {});
            return;
          }
          // Committing to the SDK turn: from here a /stop must go through
          // actor.stop(), not the pre-send abort. No await between this and the
          // send, so /stop can't interleave and start a turn we meant to cancel.
          session.currentAbort = undefined;
          await session.actor.runTurn(prompt, undefined, images);
        }
      );
      if (outcome === "aborted") {
        await this.transport.notice(threadId, "🛑 已在送出前取消，未啟動這一輪。").catch(() => {});
      }
    } catch (err) {
      await this.transport
        .notice(threadId, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
        .catch(() => {});
    } finally {
      if (session.currentAbort === ac) session.currentAbort = undefined;
      await this.transport.flush(threadId).catch(() => {});
      session.running = false;
    }
    // Drain ONE queued prompt, outside the `finally` so a queued item can never
    // interfere with this turn's cleanup, and one at a time so each drained turn
    // gets the same guards (fault check, /stop, steering) as any other.
    await this.drainQueue(threadId);
  }

  /** Start the next `/queue`d prompt, if any. `/stop` empties the queue, so a
   *  stopped turn never resurrects work the operator asked to abandon. */
  private async drainQueue(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || session.running || session.queue.length === 0) return;
    const next = session.queue.shift()!;
    const left = session.queue.length;
    await this.transport
      .notice(threadId, `▶️ 開始執行佇列中的訊息${left ? `（還有 ${left} 則）` : ""}：\n> ${next.slice(0, 300)}`)
      .catch(() => {});
    await this.runTurn(threadId, next);
  }

  /** Tear down every live session. A cleanly-disconnected session is removed; a
   *  session that FAILS or TIMES OUT on disconnect is kept (its runtime session
   *  may still be live) so a later /new retries the idempotent disconnect; a
   *  FAULTED session is a permanent fence (kept, not re-disconnected) that keeps
   *  /new refusing until the bot is restarted. Returns false if anything was
   *  left behind. */
  private async endAllSessions(reason: string): Promise<boolean> {
    let ok = true;
    for (const [threadId, session] of [...this.sessions]) {
      session.currentAbort?.abort(); // cancel any pre-send download in flight
      if (session.actor.isFaulted()) {
        ok = false; // fence — needs a restart, don't re-hit the dead runtime
        continue;
      }
      await this.transport.notice(threadId, reason).catch(() => {});
      try {
        // Bound the disconnect so a hung teardown RPC can't stall /new.
        await withTimeout(session.actor.disconnect(), TEARDOWN_TIMEOUT_MS);
        this.sessions.delete(threadId);
        this.transport.dispose(threadId);
      } catch {
        ok = false; // keep it — a later /new retries the (idempotent) disconnect
      }
    }
    return ok;
  }

  // ---- shutdown ----------------------------------------------------------

  private installSignalHandlers(): void {
    const handler = (): void => void this.stop().then(() => process.exit(0));
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  }

  /** Reverse-order teardown; the single-instance lock is released LAST. */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.phase = "shuttingDown"; // reject any late input while tearing down
    for (const [threadId, session] of this.sessions) {
      session.broker.abort();
      // Bound the disconnect: a retained fence's disconnect can be permanently
      // hung, and shutdown must not block forever on it.
      await withTimeout(session.actor.disconnect(), TEARDOWN_TIMEOUT_MS).catch(() => {});
      this.transport.dispose(threadId);
    }
    this.sessions.clear();
    try {
      this.discord.destroy();
    } catch {
      /* best effort */
    }
    await this.copilot.stop().catch(() => {});
    await this.lock.release().catch(() => {});
  }
}

function ctxOf(source: {
  user?: { id: string };
  author?: { id: string };
  guildId: string | null;
  channelId: string;
  channel: unknown;
}): AuthContext {
  const ch = source.channel as { isThread?: () => boolean; parentId?: string | null } | null;
  const isThread = ch?.isThread?.() ?? false;
  return {
    userId: source.user?.id ?? source.author?.id ?? "",
    guildId: source.guildId,
    channelId: source.channelId,
    parentId: isThread ? ch?.parentId ?? null : null,
  };
}

/** Warn (not fail) if the configured default model isn't currently available. */
async function preflightModel(copilot: CopilotClient, model: string): Promise<void> {
  try {
    const models = await copilot.listModels();
    if (!models.some((m) => m.id === model)) {
      console.warn(
        `⚠️  DEFAULT_MODEL "${model}" is not in the ${models.length} available models; ` +
          `sessions may fall back to the account default.`
      );
    }
  } catch (err) {
    console.warn(`⚠️  Could not list models for preflight: ${err instanceof Error ? err.message : err}`);
  }
}

// Keep the discord.js thread type referenced (used via casts above).
export type { AnyThreadChannel };



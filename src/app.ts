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
import { randomUUID } from "node:crypto";

import { sendUnlessAborted } from "./core/turn-gate.js";
import { shouldResetEffort, validateEffort } from "./core/effort.js";
import { createCopilotClient, checkSdkCompat } from "./copilot/sdk.js";
import { PendingInteractionBroker, type PendingView } from "./core/broker.js";
import { SessionActor, type BlobAttachment, formatTodos } from "./copilot/session-actor.js";
import { ApprovalPolicy } from "./core/approval-policy.js";
import { DiscordTransport } from "./platforms/discord/discord-transport.js";
import { decodePermissionId, decodeChoiceId, decodePlanId } from "./platforms/discord/custom-id.js";
import { isAuthorized, type AuthContext, type AuthPolicy } from "./platforms/discord/auth.js";
import type { Decision, Transport } from "./core/transport.js";

interface Session {
  actor: SessionActor;
  broker: PendingInteractionBroker;
  running: boolean;
  /** Set while a turn is reserved but the prompt hasn't been handed to the agent
   *  yet (e.g. during image download). /stop aborts this to cancel before send. */
  currentAbort?: AbortController;
}

/** Milliseconds a single session teardown may take during /new before we give
 *  up on it (and keep it for a later retry) rather than stalling. */
const TEARDOWN_TIMEOUT_MS = 5_000;

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
 * Composition root: owns the single-instance lock, the Copilot SDK client, the
 * Discord gateway connection, and the per-thread SessionActor map. Wires the
 * three input surfaces (slash commands, thread messages, permission buttons)
 * through the auth gate to the orchestration core, and shuts everything down in
 * reverse order (lock released last).
 */
export class DiscopilotApp {
  private readonly discord: Client;
  private readonly transport: Transport;
  private readonly sessions = new Map<string, Session>();
  private readonly policy: AuthPolicy;
  /** Shared approval memory (session + persisted repo rules) across sessions. */
  private readonly approvals = new ApprovalPolicy();
  private modelIds: string[] = [];
  private readonly modelEfforts = new Map<string, string[]>();
  private shuttingDown = false;
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
  ): DiscopilotApp {
    const noopLock: InstanceLock = { path: "(test)", release: async () => {} };
    return new DiscopilotApp(config, repoPath, copilot, noopLock, transport, store);
  }

  /** Build and fully start the app (lock → SDK → Discord login + commands). */
  static async start(config: Config): Promise<DiscopilotApp> {
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
    let app: DiscopilotApp | undefined;
    try {
      copilot = createCopilotClient({ workingDirectory: repoPath });
      await copilot.start();
      await preflightModel(copilot, config.DEFAULT_MODEL);
      app = new DiscopilotApp(config, repoPath, copilot, lock);
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
      `✅ discopilot ready — controlling ${this.repoPath}\n` +
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
            .setDescription("Reasoning effort")
            .setRequired(true)
            .addChoices(
              { name: "low", value: "low" },
              { name: "medium", value: "medium" },
              { name: "high", value: "high" },
              { name: "xhigh", value: "xhigh" }
            )
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
    // Expired-nonce (P2): a card posted before a restart carries a nonce that no
    // live broker knows. It's already execution-safe (settle would no-op), but
    // tell the user explicitly instead of silently blanking the buttons as if it
    // was accepted.
    const pending = this.pendingFor(nonce);
    if (!pending) {
      await interaction
        .reply({ content: "此互動已於重啟後失效，未執行任何動作。請重新操作。", flags: MessageFlags.Ephemeral })
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

      const thread = await (parent as TextChannel).threads.create({
        name: `copilot ${new Date().toISOString().slice(5, 16).replace("T", " ")}`,
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
          this.sessions.set(thread.id, { actor, broker, running: false });
          await interaction.editReply(
            "⚠️ 無法持久化 session 狀態，且無法確認前述 runtime 已關閉。已將其設為屏障以避免雙重 session——請重啟 bot。"
          );
        }
        return;
      }
      this.sessions.set(thread.id, { actor, broker, running: false });
      await interaction.editReply(`Started a session in <#${thread.id}>. Send prompts there.`);

      const prompt = interaction.options.getString("prompt");
      if (prompt) void this.runTurn(thread.id, prompt).catch(() => {});
    } finally {
      this.creating = false;
    }
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
    this.sessions.set(rec.threadId, { actor, broker, running: false });
    this.store.commit(); // keep active, refresh updatedAt
    await this.transport
      .notice(
        rec.threadId,
        "♻️ 已從重啟復原此對話（歷史保留）。上一個回合已中斷且**不會自動續跑**；" +
          "先前若有指令可能已部分或完全執行，請先確認 repo／程序狀態，再決定是否重送。"
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
    const ok = await this.stopSession(session);
    await interaction.reply({
      content: ok ? "Abort requested for the current turn." : "Abort attempted but the runtime reported an error.",
      flags: MessageFlags.Ephemeral,
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
    const u = session.actor.usage();
    const c = session.actor.config();
    const header = `model=\`${c.model ?? "?"}\` effort=\`${c.effort ?? "default"}\` context=\`${c.context ?? "default"}\``;
    const pct = u && u.tokenLimit > 0 ? Math.round((u.currentTokens / u.tokenLimit) * 100) : undefined;
    const body = u
      ? `\ntokens: ${u.currentTokens.toLocaleString()} / ${u.tokenLimit.toLocaleString()}${pct !== undefined ? ` (${pct}%)` : ""}`
      : "\n(no usage reported yet — send a message first)";
    await interaction.reply({ content: header + body, flags: MessageFlags.Ephemeral });
  }

  private async cmdApprovals(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    const clear = interaction.options.getBoolean("clear") ?? false;
    const sessionRules = this.sessions.has(interaction.channelId)
      ? this.approvals.sessionApprovals(interaction.channelId)
      : [];
    const repoRules = this.approvals.repoApprovals(this.repoPath);
    if (clear) {
      if (this.sessions.has(interaction.channelId)) this.approvals.clearSession(interaction.channelId);
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
    const rendered = formatTodos(rows);
    await interaction.editReply({ content: (rendered || "目前沒有待辦事項。").slice(0, 1900) });
  }

  // ---- input surface: thread messages -----------------------------------

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (this.phase !== "ready") return; // ignore until reconciliation finished
    const session = this.sessions.get(message.channelId);
    if (!session) return; // not a session thread
    if (!isAuthorized(ctxOf(message), this.policy)) return; // silent for non-owners
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
    // Reserve the turn (via the running guard in runTurn) BEFORE any network I/O,
    // so image downloads serialize with message arrival and two quick image
    // messages can't reorder. The download happens inside runTurn.
    await this.runTurn(message.channelId, text, message);
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
      await this.transport.notice(threadId, "⏳ Still working on the previous message — please wait.");
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



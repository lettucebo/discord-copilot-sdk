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
import { lockPath } from "./core/paths.js";
import { resolveControlledRepo } from "./core/repo.js";
import { createCopilotClient, checkSdkCompat } from "./copilot/sdk.js";
import { PendingInteractionBroker } from "./core/broker.js";
import { SessionActor } from "./copilot/session-actor.js";
import { ApprovalPolicy } from "./core/approval-policy.js";
import { DiscordTransport } from "./platforms/discord/discord-transport.js";
import { decodePermissionId, decodeChoiceId, decodePlanId } from "./platforms/discord/custom-id.js";
import { isAuthorized, type AuthContext, type AuthPolicy } from "./platforms/discord/auth.js";
import type { Decision } from "./core/transport.js";

interface Session {
  actor: SessionActor;
  broker: PendingInteractionBroker;
  running: boolean;
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

/**
 * Composition root: owns the single-instance lock, the Copilot SDK client, the
 * Discord gateway connection, and the per-thread SessionActor map. Wires the
 * three input surfaces (slash commands, thread messages, permission buttons)
 * through the auth gate to the orchestration core, and shuts everything down in
 * reverse order (lock released last).
 */
export class DiscopilotApp {
  private readonly discord: Client;
  private readonly transport: DiscordTransport;
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

  private constructor(
    private readonly config: Config,
    private readonly repoPath: string,
    private readonly copilot: CopilotClient,
    private readonly lock: InstanceLock
  ) {
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.transport = new DiscordTransport(this.discord);
    this.policy = {
      allowedUserIds: new Set(this.config.DISCORD_ALLOWED_USER_IDS),
      guildId: this.config.DISCORD_GUILD_ID,
      parentChannelId: this.config.DISCORD_PARENT_CHANNEL_ID,
    };
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
        const efforts = (m.supportedReasoningEfforts as string[] | undefined) ?? [];
        if (efforts.length) this.modelEfforts.set(m.id, efforts);
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
      // v1 runs ONE live session at a time: all sessions share the single
      // controlled working tree, so two concurrent agents could clobber each
      // other's checkout/edits. Refuse to start if the previous one won't end.
      const ended = await this.endAllSessions("A new session was started; this one has ended.");
      if (!ended) {
        await interaction.editReply(
          "Could not cleanly end the previous session (it may have faulted). Not starting a " +
            "new one — retry, or restart the bot if this persists."
        );
        return;
      }

      const thread = await (parent as TextChannel).threads.create({
        name: `copilot ${new Date().toISOString().slice(5, 16).replace("T", " ")}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      const broker = new PendingInteractionBroker();
      const actor = await SessionActor.create(this.copilot, {
        sessionKey: thread.id,
        workingDirectory: this.repoPath,
        model: this.config.DEFAULT_MODEL,
        contextTier: this.config.DEFAULT_CONTEXT_TIER,
        broker,
        transport: this.transport,
        policy: this.approvals,
      });
      this.sessions.set(thread.id, { actor, broker, running: false });
      await interaction.editReply(`Started a session in <#${thread.id}>. Send prompts there.`);

      const prompt = interaction.options.getString("prompt");
      if (prompt) void this.runTurn(thread.id, prompt);
    } finally {
      this.creating = false;
    }
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
    const ok = await session.actor.stop();
    await interaction.reply({
      content: ok ? "Abort requested for the current turn." : "Abort attempted but the runtime reported an error.",
      flags: MessageFlags.Ephemeral,
    });
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
    const change: { model?: string; effort?: string; context?: "default" | "long_context" } = {};
    const cur = session.actor.config();
    if (interaction.commandName === "model") {
      const id = interaction.options.getString("id", true);
      if (this.modelIds.length && !this.modelIds.includes(id)) {
        await interaction.reply({ content: `Unknown model \`${id}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }
      change.model = id;
    } else if (interaction.commandName === "effort") {
      const level = interaction.options.getString("level", true);
      const supported = this.modelEfforts.get(change.model ?? cur.model ?? "");
      if (supported && supported.length && !supported.includes(level)) {
        await interaction.reply({
          content: `Model \`${cur.model}\` supports effort: ${supported.join(", ")}.`,
          flags: MessageFlags.Ephemeral,
        });
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
    const body = u
      ? `\ntokens: ${u.currentTokens.toLocaleString()} / ${u.tokenLimit.toLocaleString()} (${Math.round((u.currentTokens / u.tokenLimit) * 100)}%)`
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
      this.approvals.clearRepo(this.repoPath);
      await interaction.reply({
        content:
          `Cleared approvals — session: ${fmtList(sessionRules)} · repo: ${fmtList(repoRules)}. ` +
          `Future commands will prompt again.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `Approved (auto-run, no prompt):\n• session: ${fmtList(sessionRules)}\n• this repo: ${fmtList(repoRules)}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ---- input surface: thread messages -----------------------------------

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const session = this.sessions.get(message.channelId);
    if (!session) return; // not a session thread
    if (!isAuthorized(ctxOf(message), this.policy)) return; // silent for non-owners
    const prompt = message.content.trim();
    if (!prompt) {
      await this.transport.notice(
        message.channelId,
        "Empty message — is the Message Content intent enabled for this bot?"
      );
      return;
    }
    // If the agent is awaiting a freeform ask_user answer, this message answers
    // it (rather than starting a new turn or hitting the "still working" guard).
    if (session.actor.tryConsumeFreeform(prompt)) return;
    await this.runTurn(message.channelId, prompt);
  }

  /** Run one prompt to real completion (session.idle), guarding against
   *  overlapping sends per thread. `running` stays set for the WHOLE turn. */
  private async runTurn(threadId: string, prompt: string): Promise<void> {
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
    this.transport.resetTurn(threadId);
    try {
      await session.actor.runTurn(prompt);
    } catch (err) {
      await this.transport.notice(threadId, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
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
    for (const [threadId, session] of this.sessions) {
      session.broker.abort();
      await session.actor.disconnect().catch(() => {});
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

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
import { DiscordTransport } from "./platforms/discord/discord-transport.js";
import { decodePermissionId } from "./platforms/discord/custom-id.js";
import { isAuthorized, type AuthContext, type AuthPolicy } from "./platforms/discord/auth.js";

interface Session {
  actor: SessionActor;
  broker: PendingInteractionBroker;
  running: boolean;
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
  private shuttingDown = false;

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

  /** Build and fully start the app (lock → SDK → Discord login). */
  static async start(config: Config): Promise<DiscopilotApp> {
    const repoPath = resolveControlledRepo(config.CONTROLLED_REPO_PATH);
    const compat = checkSdkCompat();
    if (!compat.ok) {
      console.warn(`⚠️  installed SDK ${compat.installed} != declared ${compat.declared}`);
    }
    const lock = await acquireSingleInstanceLock(lockPath());
    let copilot: CopilotClient | undefined;
    try {
      copilot = createCopilotClient({ workingDirectory: repoPath });
      await copilot.start();
      await preflightModel(copilot, config.DEFAULT_MODEL);
      const app = new DiscopilotApp(config, repoPath, copilot, lock);
      await app.login();
      return app;
    } catch (err) {
      if (copilot) await copilot.stop().catch(() => {});
      await lock.release().catch(() => {});
      throw err;
    }
  }

  private async login(): Promise<void> {
    this.discord.once(Events.ClientReady, (c) => void this.onReady(c.user.id));
    this.discord.on(Events.InteractionCreate, (i) => void this.onInteraction(i));
    this.discord.on(Events.MessageCreate, (m) => void this.onMessage(m));
    this.installSignalHandlers();
    await this.discord.login(this.config.DISCORD_BOT_TOKEN);
  }

  private async onReady(clientId: string): Promise<void> {
    await this.registerCommands(clientId);
    console.log(
      `✅ discopilot ready — controlling ${this.repoPath}\n` +
        `   guild=${this.config.DISCORD_GUILD_ID} channel=${this.config.DISCORD_PARENT_CHANNEL_ID}\n` +
        `   model=${this.config.DEFAULT_MODEL} contextTier=${this.config.DEFAULT_CONTEXT_TIER}`
    );
  }

  private async registerCommands(clientId: string): Promise<void> {
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
    ];
    const guildId = this.config.DEV_GUILD_ID ?? this.config.DISCORD_GUILD_ID;
    const rest = new REST({ version: "10" }).setToken(this.config.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  }

  // ---- input surface: interactions (slash + buttons) --------------------

  private async onInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isButton()) {
        await this.onButton(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "new") await this.cmdNew(interaction);
        else if (interaction.commandName === "stop") await this.cmdStop(interaction);
      }
    } catch (err) {
      console.error("interaction error:", err);
    }
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const decoded = decodePermissionId(interaction.customId);
    if (!decoded) return;
    if (!isAuthorized(ctxOf(interaction), this.policy)) {
      await interaction.reply({ content: "Not authorized.", flags: MessageFlags.Ephemeral });
      return;
    }
    this.transport.deliverDecision(decoded.nonce, decoded.action, interaction.user.id);
    // Ack + remove the buttons so they can't be double-clicked.
    await interaction.update({ components: [] }).catch(() => {});
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
    const parent = await this.discord.channels.fetch(this.config.DISCORD_PARENT_CHANNEL_ID);
    if (!parent || parent.type !== ChannelType.GuildText) {
      await interaction.editReply("Parent channel is not a text channel.");
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
    });
    this.sessions.set(thread.id, { actor, broker, running: false });
    await interaction.editReply(`Started a session in <#${thread.id}>. Send prompts there.`);

    const prompt = interaction.options.getString("prompt");
    if (prompt) void this.runTurn(thread.id, prompt);
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
    await session.actor.stop();
    await interaction.reply({ content: "Aborted the current turn.", flags: MessageFlags.Ephemeral });
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
    await this.runTurn(message.channelId, prompt);
  }

  /** Run one prompt→idle turn, guarding against overlapping sends per thread. */
  private async runTurn(threadId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.running) {
      await this.transport.notice(threadId, "⏳ Still working on the previous message — please wait.");
      return;
    }
    session.running = true;
    this.transport.resetTurn(threadId);
    try {
      await session.actor.send(prompt);
      await session.actor.waitIdle();
    } catch (err) {
      await this.transport.notice(threadId, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.transport.flush(threadId);
      session.running = false;
    }
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
    for (const [, session] of this.sessions) {
      session.broker.abort();
      await session.actor.disconnect().catch(() => {});
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

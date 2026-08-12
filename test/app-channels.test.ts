import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import type { CopilotClient } from "@github/copilot-sdk";
import { DiscordCopilotApp, type Session } from "../src/app.js";
import type { Config } from "../src/config.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import type { Transport } from "../src/core/transport.js";
import type { OutboundFile } from "../src/core/outbound-file.js";
import { isAuthorized, type AuthPolicy } from "../src/platforms/discord/auth.js";

const OWNER = "10000";
const GUILD = "20000";
const SEED = "30000";
const SECONDARY = "40000";
const FIXTURES = join(process.cwd(), ".test-fixtures-app-channels");

class FakeTransport implements Transport {
  async render(): Promise<void> {}
  async sendFile(): Promise<{ ok: true } | { ok: false; reason: "no-attach-permission" | "too-large" | "blocked" | "unavailable" | "transient" }> {
    return { ok: false, reason: "unavailable" };
  }
  async showPermission(): Promise<void> {}
  async showUserInput(): Promise<void> {}
  async showPlan(): Promise<void> {}
  async notice(): Promise<void> {}
  async noticeDelivered(): Promise<boolean> {
    return true;
  }
  onDecision(): () => void {
    return () => {};
  }
  onChoice(): () => void {
    return () => {};
  }
  onPlan(): () => void {
    return () => {};
  }
  deliverDecision(): void {}
  deliverChoice(): void {}
  deliverPlan(): void {}
  async flush(): Promise<void> {}
  resetTurn(): void {}
  dispose(): void {}
}

interface FakeSlash {
  user: { id: string };
  guildId: string | null;
  channelId: string;
  channel: { isThread: () => boolean; parentId?: string | null };
  options: {
    getSubcommand: () => string;
    getString: (name: string) => string | null;
  };
  replies: unknown[];
  defers: unknown[];
  edits: string[];
  reply: (value: unknown) => Promise<void>;
  deferReply: (value: unknown) => Promise<void>;
  editReply: (value: unknown) => Promise<void>;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "content" in value && typeof value.content === "string") {
    return value.content;
  }
  return "";
}

function slash(
  over: Partial<{
    userId: string;
    guildId: string | null;
    channelId: string;
    threadParentId: string | null;
    subcommand: string;
    strings: Record<string, string | null>;
    defer: () => Promise<void>;
  }> = {}
): FakeSlash {
  const replies: unknown[] = [];
  const defers: unknown[] = [];
  const edits: string[] = [];
  const thread = over.threadParentId !== undefined;
  return {
    user: { id: over.userId ?? OWNER },
    guildId: over.guildId ?? GUILD,
    channelId: over.channelId ?? SEED,
    channel: {
      isThread: () => thread,
      ...(thread ? { parentId: over.threadParentId } : {}),
    },
    options: {
      getSubcommand: () => over.subcommand ?? "list",
      getString: (name) => over.strings?.[name] ?? null,
    },
    replies,
    defers,
    edits,
    async reply(value): Promise<void> {
      replies.push(value);
    },
    async deferReply(value): Promise<void> {
      defers.push(value);
      await over.defer?.();
    },
    async editReply(value): Promise<void> {
      edits.push(textOf(value));
    },
  };
}

function asInteraction(fake: FakeSlash): ChatInputCommandInteraction {
  return fake as unknown as ChatInputCommandInteraction;
}

function config(reposRoot: string): Config {
  return {
    DISCORD_BOT_TOKEN: "token",
    DISCORD_ALLOWED_USER_IDS: [OWNER],
    DISCORD_GUILD_ID: GUILD,
    DISCORD_PARENT_CHANNEL_ID: SEED,
    DEV_GUILD_ID: undefined,
    REPOS_ROOT: reposRoot,
    DEFAULT_REPO: "repo",
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_CONTEXT_TIER: "default",
    PERMISSION_POLICY: "ask",
    ENABLE_REPO_SKILLS: "true",
    ENABLE_USER_SKILLS: "true",
    REPO_CLONE_HOST_POLICY: "github",
    REPO_CLONE_ALLOWED_HOSTS: [],
    REPO_CLONE_TIMEOUT_MS: 300_000,
    TITLE_MODEL: undefined,
  };
}

interface Harness {
  app: DiscordCopilotApp;
  registry: ChannelRegistry;
  store: SessionStore;
}

function harness(registryFile = join(FIXTURES, "channels.json")): Harness {
  const reposRoot = join(FIXTURES, "repos");
  mkdirSync(reposRoot, { recursive: true });
  const registry = new ChannelRegistry(SEED, GUILD, registryFile);
  const store = new SessionStore(join(FIXTURES, "sessions.json"));
  const app = DiscordCopilotApp.createForTest(
    config(reposRoot),
    reposRoot,
    {} as unknown as CopilotClient,
    new FakeTransport(),
    store,
    registry
  );
  return { app, registry, store };
}

function cmdChannel(app: DiscordCopilotApp, interaction: ChatInputCommandInteraction): Promise<void> {
  return (
    app as unknown as {
      cmdChannel(i: ChatInputCommandInteraction): Promise<void>;
    }
  ).cmdChannel(interaction);
}

type DiscordForTest = {
  discord: {
    channels: {
      fetch(channelId: string): Promise<unknown>;
    };
  };
};

function patchChannelFetch(app: DiscordCopilotApp, fetch: (channelId: string) => Promise<unknown>): void {
  (app as unknown as DiscordForTest).discord.channels.fetch = fetch;
}

function sessionsOf(app: DiscordCopilotApp): Map<string, Session> {
  return (app as unknown as { sessions: Map<string, Session> }).sessions;
}

function session(parentChannelId: string): Session {
  return {
    actor: {} as unknown as Session["actor"],
    broker: new PendingInteractionBroker(),
    running: false,
    titled: true,
    titleEpoch: 0,
    queue: [],
    workDir: join(FIXTURES, "repo"),
    repoPath: join(FIXTURES, "repo"),
    devMode: "local",
    parentChannelId,
    hasRunTurn: false,
  };
}

function binding(threadId: string, parentChannelId: string): SessionBinding {
  const repoPath = join(FIXTURES, "repo");
  return {
    threadId,
    sessionId: `session-${threadId}`,
    generation: Number(threadId.replace(/\D/g, "")) || 1,
    repoPath,
    guildId: GUILD,
    parentChannelId,
    workDir: repoPath,
    devMode: "local",
  };
}

beforeEach(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
});

afterEach(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

describe("/channel", () => {
  it("enables an owner-selected text channel only after acknowledging, despite missing operational permissions", async () => {
    const { app, registry } = harness();
    let releaseAck!: () => void;
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const interaction = slash({
      channelId: SECONDARY,
      subcommand: "enable",
      defer: () => ack,
    });
    patchChannelFetch(app, async () => ({
      type: ChannelType.GuildText,
      guildId: GUILD,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => false }),
    }));

    const enabling = cmdChannel(app, asInteraction(interaction));
    await Promise.resolve();

    expect(interaction.defers).toHaveLength(1);
    expect(registry.has(SECONDARY)).toBe(false);

    releaseAck();
    await enabling;

    expect(interaction.edits.join("\n")).toContain("缺少這些權限");
    expect(registry.has(SECONDARY)).toBe(true);
    const snapshot: AuthPolicy = {
      allowedUserIds: new Set([OWNER]),
      guildId: GUILD,
      parentChannelIds: registry.enabledSet(),
    };
    expect(isAuthorized({ userId: OWNER, guildId: GUILD, channelId: SECONDARY, parentId: null }, snapshot)).toBe(
      true
    );
  });

  it.each([
    ["thread", ChannelType.PublicThread],
    ["forum", ChannelType.GuildForum],
    ["voice channel", ChannelType.GuildVoice],
  ])("refuses a %s target", async (_kind, type) => {
    const { app, registry } = harness();
    const interaction = slash({ subcommand: "enable", strings: { channel: SECONDARY } });
    patchChannelFetch(app, async () => ({ type, guildId: GUILD }));

    await cmdChannel(app, asInteraction(interaction));

    expect(registry.has(SECONDARY)).toBe(false);
    expect(interaction.edits.join("\n")).toContain("不是一般文字頻道");
  });

  it("refuses a GuildText target in a foreign guild", async () => {
    const { app, registry } = harness();
    const interaction = slash({ subcommand: "enable", strings: { channel: SECONDARY } });
    patchChannelFetch(app, async () => ({ type: ChannelType.GuildText, guildId: "99999" }));

    await cmdChannel(app, asInteraction(interaction));

    expect(registry.has(SECONDARY)).toBe(false);
    expect(interaction.edits.join("\n")).toContain("不在設定的伺服器");
  });

  it("rejects an invalid explicit target instead of enabling the current channel", async () => {
    const { app, registry } = harness();
    const fetch = vi.fn(async () => ({ type: ChannelType.GuildText, guildId: GUILD }));
    patchChannelFetch(app, fetch);
    const interaction = slash({
      channelId: SECONDARY,
      subcommand: "enable",
      strings: { channel: "this-is-not-a-channel-id" },
    });

    await cmdChannel(app, asInteraction(interaction));

    expect(fetch).not.toHaveBeenCalled();
    expect(registry.has(SECONDARY)).toBe(false);
    expect(textOf(interaction.replies[0])).toContain("只接受頻道 ID");
  });

  it("refuses to disable the seed or a channel held by live and durable sessions", async () => {
    const { app, registry, store } = harness();
    expect(registry.enable(SECONDARY, OWNER)).toBe(true);
    sessionsOf(app).set("live-thread", session(SECONDARY));
    expect(store.reserve(binding("active-thread", SECONDARY))).toBe(true);
    expect(store.commit("active-thread")).toBe(true);
    expect(store.reserve(binding("creating-thread", SECONDARY))).toBe(true);

    const seed = slash({ subcommand: "disable" });
    await cmdChannel(app, asInteraction(seed));
    expect(registry.has(SEED)).toBe(true);
    expect(textOf(seed.replies[0])).toContain("不能從 Discord 停用");

    const secondary = slash({ subcommand: "disable", strings: { channel: SECONDARY } });
    await cmdChannel(app, asInteraction(secondary));

    expect(registry.has(SECONDARY)).toBe(true);
    expect(textOf(secondary.replies[0])).toContain("3 個 session");
  });

  it("disables a deleted enabled channel by raw id when invoked from the seed", async () => {
    const { app, registry } = harness();
    expect(registry.enable(SECONDARY, OWNER)).toBe(true);
    const interaction = slash({ channelId: SEED, subcommand: "disable", strings: { channel: SECONDARY } });

    await cmdChannel(app, asInteraction(interaction));

    expect(registry.has(SECONDARY)).toBe(false);
    expect(textOf(interaction.replies[0])).toContain("已停用");
  });

  it("reports a failed registry persistence and leaves authorization unchanged", async () => {
    const blockedParent = join(FIXTURES, "not-a-directory");
    const file = join(blockedParent, "channels.json");
    const { app, registry } = harness(file);
    writeFileSync(blockedParent, "a file prevents the registry directory", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const interaction = slash({ subcommand: "enable", strings: { channel: SECONDARY } });
    patchChannelFetch(app, async () => ({ type: ChannelType.GuildText, guildId: GUILD }));

    try {
      await cmdChannel(app, asInteraction(interaction));
    } finally {
      warn.mockRestore();
    }

    expect(registry.has(SECONDARY)).toBe(false);
    expect(interaction.edits.join("\n")).toContain("沒有**啟用");
  });

  it("explains that authorization does not control Discord command visibility", async () => {
    const { app } = harness();
    const interaction = slash({ subcommand: "list" });

    await cmdChannel(app, asInteraction(interaction));

    expect(textOf(interaction.replies[0])).toContain("bot 的授權");
    expect(textOf(interaction.replies[0])).toContain("不等於");
    expect(textOf(interaction.replies[0])).toContain("Server Settings → Integrations");
  });
});

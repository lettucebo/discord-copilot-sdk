import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { CopilotClient } from "@github/copilot-sdk";
import { DiscordCopilotApp, type Session } from "../src/app.js";
import type { Config } from "../src/config.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import { isAuthorized, type AuthPolicy } from "../src/platforms/discord/auth.js";
import type { OwnedScope } from "../src/core/lifecycle-ownership.js";
import { inOwnedScope } from "./support/owned-scope.js";
import {
  appTestDependencies,
  type AppTestDependencyOverrides,
} from "./support/app-test-dependencies.js";

const OWNER = "10000";
const GUILD = "20000";
const SEED = "30000";
const SECONDARY = "40000";
const VISIBLE_DISABLED = "50000";
const FIXTURES = join(process.cwd(), ".test-fixtures-app-channels");

/** The dependency object `createForTest` requires, sourced from this suite's
 *  fixture directory instead of the home directory of whoever runs it. */
const appDependencies = (over: AppTestDependencyOverrides): ReturnType<typeof appTestDependencies> =>
  appTestDependencies({ directory: FIXTURES, parentChannelId: SEED, guildId: GUILD }, over);

class FakeTransport implements Transport {
  async render(): Promise<void> {}
  async sendFile(..._args: Parameters<Transport["sendFile"]>): Promise<SendFileResult> {
    return { ok: false, reason: "unavailable" };
  }
  async showPermission(): Promise<void> {}
  async showUserInput(): Promise<void> {}
  async showPlan(): Promise<void> {}
  async notice(..._args: Parameters<Transport["notice"]>): Promise<void> {}
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
    getBoolean: (name: string) => boolean | null;
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
      getBoolean: () => null,
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
    REPOS_ROOT: reposRoot,
    DEFAULT_REPO: "repo",
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_CONTEXT_TIER: "default",
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
    appDependencies({ store, channels: registry })
  );
  return { app, registry, store };
}

function cmdChannel(app: DiscordCopilotApp, interaction: ChatInputCommandInteraction): Promise<void> {
  // Through a REAL scope from the app's own coordinator: the handler now
  // requires one, and a fabricated "never lost" scope would make every
  // shutdown-race assertion in this area vacuous.
  return inOwnedScope(app, (scope) =>
    (
      app as unknown as {
        cmdChannel(i: ChatInputCommandInteraction, s: OwnedScope): Promise<void>;
      }
    ).cmdChannel(interaction, scope)
  );
}

function cmdSessions(app: DiscordCopilotApp, interaction: ChatInputCommandInteraction): Promise<void> {
  return (
    app as unknown as {
      cmdSessions(i: ChatInputCommandInteraction): Promise<void>;
    }
  ).cmdSessions(interaction);
}

function cmdYolo(app: DiscordCopilotApp, interaction: ChatInputCommandInteraction): Promise<void> {
  // Through a REAL scope from the app's own coordinator: the handler now
  // requires one, and a fabricated "never lost" scope would make every
  // shutdown-race assertion in this area vacuous.
  return inOwnedScope(app, (scope) =>
    (
      app as unknown as {
        cmdYolo(i: ChatInputCommandInteraction, s: OwnedScope): Promise<void>;
      }
    ).cmdYolo(interaction, scope)
  );
}

type DiscordForTest = {
  discord: {
    channels: {
      fetch(channelId: string): Promise<unknown>;
      cache: Map<string, unknown>;
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
      permissionsFor: () => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel }),
    }));

    const enabling = cmdChannel(app, asInteraction(interaction));
    await Promise.resolve();

    expect(interaction.defers).toHaveLength(1);
    expect(registry.has(SECONDARY)).toBe(false);

    releaseAck();
    await enabling;

    expect(interaction.edits.join("\n")).toContain("缺少這些權限");
    expect(interaction.edits.join("\n")).toContain("Attach Files");
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

  it("does not diagnose Attach Files when file delivery is unavailable on this platform", async () => {
    const reposRoot = join(FIXTURES, "repos-nonwin-permissions");
    mkdirSync(reposRoot, { recursive: true });
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels-nonwin-permissions.json"));
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as unknown as CopilotClient,
      new FakeTransport(),
      appDependencies({ store: new SessionStore(join(FIXTURES, "sessions-nonwin-permissions.json")), channels: registry, fileDeliveryPlatform: "linux" })
    );
    const interaction = slash({ channelId: SECONDARY, subcommand: "enable" });
    patchChannelFetch(app, async () => ({
      type: ChannelType.GuildText,
      guildId: GUILD,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel }),
    }));

    await cmdChannel(app, asInteraction(interaction));

    expect(interaction.edits.join("\n")).toContain("缺少這些權限");
    expect(interaction.edits.join("\n")).not.toContain("Attach Files");
    expect(registry.has(SECONDARY)).toBe(true);
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

  it("refuses a private channel until the bot has View Channel", async () => {
    const { app, registry } = harness();
    const interaction = slash({ subcommand: "enable", strings: { channel: SECONDARY } });
    patchChannelFetch(app, async () => ({
      type: ChannelType.GuildText,
      guildId: GUILD,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => false }),
    }));

    await cmdChannel(app, asInteraction(interaction));

    expect(registry.has(SECONDARY)).toBe(false);
    expect(interaction.edits.join("\n")).toContain("編輯頻道 → 權限");
    expect(interaction.edits.join("\n")).toContain("把這個 bot 加進去");
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

  it("allows disabling the imported default but refuses a channel held by live and durable sessions", async () => {
    const { app, registry, store } = harness();
    expect(registry.enable(SECONDARY, OWNER)).toBe(true);
    sessionsOf(app).set("live-thread", session(SECONDARY));
    expect(store.reserve(binding("active-thread", SECONDARY))).toBe(true);
    expect(store.commit("active-thread")).toBe(true);
    expect(store.reserve(binding("creating-thread", SECONDARY))).toBe(true);

    const seed = slash({ subcommand: "disable" });
    await cmdChannel(app, asInteraction(seed));
    expect(registry.has(SEED)).toBe(false);
    expect(textOf(seed.replies[0])).toContain("已停用");

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
    rmSync(blockedParent, { recursive: true, force: true });
    writeFileSync(blockedParent, "a file prevents the registry directory", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const interaction = slash({ subcommand: "enable", strings: { channel: SECONDARY } });
    patchChannelFetch(app, async () => ({
      type: ChannelType.GuildText,
      guildId: GUILD,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => true }),
    }));

    try {
      await cmdChannel(app, asInteraction(interaction));
    } finally {
      warn.mockRestore();
    }

    expect(registry.has(SECONDARY)).toBe(false);
    expect(interaction.edits.join("\n")).toContain("沒有**啟用");
  });

  it("audits runtime authorization against Discord visibility", async () => {
    const { app } = harness();
    const interaction = slash({ subcommand: "list" });
    patchChannelFetch(app, async (id) => ({
      id,
      type: ChannelType.GuildText,
      guildId: GUILD,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => true }),
    }));

    await cmdChannel(app, asInteraction(interaction));

    expect(textOf(interaction.replies[0])).toContain("頻道白名單與可見度");
    expect(textOf(interaction.replies[0])).toContain("✅ 可見");
    expect(textOf(interaction.replies[0])).toContain("首次啟動預設值");
  });

  it("reports a visible text channel that runtime authorization has not enabled", async () => {
    const { app } = harness();
    const interaction = slash({ subcommand: "list" });
    const visibleChannel = {
      id: VISIBLE_DISABLED,
      type: ChannelType.GuildText,
      guildId: GUILD,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => true }),
    };
    (app as unknown as DiscordForTest).discord.channels.cache.set(VISIBLE_DISABLED, visibleChannel);
    patchChannelFetch(app, async (id) => ({
      id,
      type: ChannelType.GuildText,
      guildId: GUILD,
      guild: { members: { me: {} } },
      permissionsFor: () => ({ has: () => true }),
    }));

    await cmdChannel(app, asInteraction(interaction));

    const text = textOf(interaction.replies[0]);
    expect(text).toContain("bot 看得到、但尚未在程式內啟用");
    expect(text).toContain(`<#${VISIBLE_DISABLED}>`);
  });

  it("separates clearable Discord no-access records from protected transient retries", async () => {
    const { app, store } = harness();
    expect(store.reserve(binding("no-access-thread", SEED))).toBe(true);
    expect(store.commit("no-access-thread")).toBe(true);
    expect(store.setState("no-access-thread", "active", "thread-no-access")).toBe(true);
    expect(store.reserve(binding("transient-thread", SEED))).toBe(true);
    expect(store.commit("transient-thread")).toBe(true);
    expect(store.setState("transient-thread", "active", "transient-thread-fetch")).toBe(true);
    const interaction = slash({ channelId: SEED });

    await cmdSessions(app, asInteraction(interaction));

    const text = textOf(interaction.replies[0]);
    expect(text).toContain("Discord 暫時無法存取");
    expect(text).toContain("/end thread:<id>");
    expect(text).toContain("no-access-thread");
    expect(text).toContain("暫時無法復原、**重啟後會再試**的記錄（不會被清除）");
    expect(text).toContain("transient-thread");
  });
  it("keeps /yolo mode:on gated on the ack and then emits the live notice with file guidance", async () => {
    const notices: Array<{ key: string; text: string }> = [];
    class NoticeTransport extends FakeTransport {
      override async notice(key: string, text: string): Promise<void> {
        notices.push({ key, text });
      }
    }

    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(reposRoot, { recursive: true });
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as unknown as CopilotClient,
      new NoticeTransport(),
      appDependencies({ store: new SessionStore(join(FIXTURES, "sessions-yolo.json")), channels: new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels-yolo.json")) })
    );

    const state = { on: false, epoch: 0 };
    const actor = {
      hasRepoSkills: () => false,
      yoloEpochValue: () => state.epoch,
      setYolo: (on: boolean) => {
        state.epoch++;
        state.on = on;
      },
      enableYoloIfCurrent: async (epoch: number) => {
        await Promise.resolve();
        if (epoch !== state.epoch) return false;
        state.on = true;
        return true;
      },
    } as unknown as Pick<Session["actor"], "hasRepoSkills" | "yoloEpochValue" | "setYolo" | "enableYoloIfCurrent">;

    sessionsOf(app).set("thread-yolo", {
      actor: actor as Session["actor"],
      broker: new PendingInteractionBroker(),
      running: false,
      titled: true,
      titleEpoch: 0,
      queue: [],
      workDir: join(FIXTURES, "repo"),
      repoPath: join(FIXTURES, "repo"),
      devMode: "local",
      parentChannelId: SEED,
      hasRunTurn: false,
    });

    let releaseAck!: () => void;
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const interaction = slash({
      channelId: "thread-yolo",
      threadParentId: SEED,
      strings: { mode: "on" },
      defer: () => ack,
    });

    const enabling = cmdYolo(app, asInteraction(interaction));
    await Promise.resolve();

    expect(interaction.replies).toHaveLength(1);
    expect(state.on).toBe(false);
    expect(notices).toEqual([]);

    releaseAck();
    await Promise.resolve();

    expect(interaction.replies).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/discord_send_file/i),
        flags: MessageFlags.Ephemeral,
      }),
    ]);
    expect(interaction.replies[0]).toEqual(expect.objectContaining({ content: expect.stringMatching(/\/file path:</i) }));
    await enabling;

    expect(state.on).toBe(true);
    expect(notices).toEqual([
      {
        key: "thread-yolo",
        text: "⚡ **YOLO mode ON** — other permissions are now auto-approved for this session; `discord_send_file` is fast-denied, so use `/file path:<file>` to deliver files.",
      },
    ]);
  });

  it("on non-Windows, /yolo mode:on warns and notices that outbound file delivery is unavailable", async () => {
    const notices: Array<{ key: string; text: string }> = [];
    class NoticeTransport extends FakeTransport {
      override async notice(key: string, text: string): Promise<void> {
        notices.push({ key, text });
      }
    }

    const reposRoot = join(FIXTURES, "repos-nonwin");
    mkdirSync(reposRoot, { recursive: true });
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as unknown as CopilotClient,
      new NoticeTransport(),
      appDependencies({ store: new SessionStore(join(FIXTURES, "sessions-yolo-nonwin.json")), channels: new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels-yolo-nonwin.json")), fileDeliveryPlatform: "linux" })
    );

    const state = { on: false, epoch: 0 };
    const actor = {
      hasRepoSkills: () => false,
      yoloEpochValue: () => state.epoch,
      setYolo: (on: boolean) => {
        state.epoch++;
        state.on = on;
      },
      enableYoloIfCurrent: async (epoch: number) => {
        await Promise.resolve();
        if (epoch !== state.epoch) return false;
        state.on = true;
        return true;
      },
    } as unknown as Pick<Session["actor"], "hasRepoSkills" | "yoloEpochValue" | "setYolo" | "enableYoloIfCurrent">;

    sessionsOf(app).set("thread-yolo-nonwin", {
      actor: actor as Session["actor"],
      broker: new PendingInteractionBroker(),
      running: false,
      titled: true,
      titleEpoch: 0,
      queue: [],
      workDir: join(FIXTURES, "repo-nonwin"),
      repoPath: join(FIXTURES, "repo-nonwin"),
      devMode: "local",
      parentChannelId: SEED,
      hasRunTurn: false,
    });

    const interaction = slash({
      channelId: "thread-yolo-nonwin",
      threadParentId: SEED,
      strings: { mode: "on" },
    });

    await cmdYolo(app, asInteraction(interaction));

    expect(interaction.replies).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/outbound Discord file delivery is unavailable on this platform/i),
        flags: MessageFlags.Ephemeral,
      }),
    ]);
    expect(interaction.replies[0]).toEqual(
      expect.not.objectContaining({ content: expect.stringMatching(/discord_send_file|\/file path:</i) })
    );
    expect(state.on).toBe(true);
    expect(notices).toEqual([
      {
        key: "thread-yolo-nonwin",
        text: "⚡ **YOLO mode ON** — other permissions are now auto-approved for this session; outbound Discord file delivery is unavailable on this platform.",
      },
    ]);
  });

});

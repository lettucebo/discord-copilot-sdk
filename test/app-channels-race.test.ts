import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import type { CopilotClient } from "@github/copilot-sdk";
import { DiscordCopilotApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { Binding, BindingDeps, BindingVerdict } from "../src/core/binding.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import { SessionStore } from "../src/core/session-store.js";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import { removeWorktreeIfClean, worktreeBranch, worktreePath } from "../src/core/worktree.js";
import { worktreeRoot } from "../src/core/paths.js";

const OWNER = "10000";
const GUILD = "20000";
const SEED = "30000";
const SECONDARY = "40000";
const UNRELATED = "50000";
const FIXTURES = join(process.cwd(), ".test-fixtures-app-channels-race");
const RACE_THREAD_ID = `channel-race-reserve-fence-${process.pid}`;
const UNRELATED_RACE_THREAD_ID = `channel-race-unrelated-mutation-${process.pid}`;
const run = promisify(execFile);

let cleanupRepo: string | undefined;
let cleanupWorktree: string | undefined;
let cleanupBranch: string | undefined;

class FakeTransport implements Transport {
  async render(): Promise<void> {}
  async sendFile(..._args: Parameters<Transport["sendFile"]>): Promise<SendFileResult> {
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
  guildId: string;
  channelId: string;
  channel: { isThread: () => boolean };
  options: {
    getSubcommand: () => string;
    getString: () => string | null;
  };
  defers: unknown[];
  edits: string[];
  reply: (value: unknown) => Promise<void>;
  deferReply: (value: unknown) => Promise<void>;
  editReply: (value: unknown) => Promise<void>;
}

function slash(channelId = SECONDARY): FakeSlash {
  const defers: unknown[] = [];
  const edits: string[] = [];
  return {
    user: { id: OWNER },
    guildId: GUILD,
    channelId,
    channel: { isThread: () => false },
    options: {
      getSubcommand: () => "new",
      getString: () => null,
    },
    defers,
    edits,
    async reply(): Promise<void> {},
    async deferReply(value): Promise<void> {
      defers.push(value);
    },
    async editReply(value): Promise<void> {
      edits.push(typeof value === "string" ? value : "");
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

function cmdNew(app: DiscordCopilotApp, interaction: ChatInputCommandInteraction): Promise<void> {
  return (
    app as unknown as {
      cmdNew(i: ChatInputCommandInteraction): Promise<void>;
    }
  ).cmdNew(interaction);
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

type BindingCheckForTest = {
  bindingCheck(binding: Binding, deps: BindingDeps): Promise<BindingVerdict>;
};

function patchBindingCheck(
  app: DiscordCopilotApp,
  check: (binding: Binding, deps: BindingDeps) => Promise<BindingVerdict>
): void {
  (app as unknown as BindingCheckForTest).bindingCheck = check;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

async function makeRepo(): Promise<string> {
  const repo = join(FIXTURES, "repos", "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "user.name", "Channel race test");
  writeFileSync(join(repo, "README.md"), "initial commit\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

async function cleanupKnownWorktree(): Promise<void> {
  const repo = cleanupRepo;
  const worktree = cleanupWorktree;
  const branch = cleanupBranch;
  cleanupRepo = undefined;
  cleanupWorktree = undefined;
  cleanupBranch = undefined;
  if (!repo || !worktree || !branch || !existsSync(worktree)) return;

  const outcome = await removeWorktreeIfClean(repo, worktree, branch);
  if (outcome !== "removed" && existsSync(worktree)) {
    await git(repo, "worktree", "remove", "--force", worktree);
  }
  if (existsSync(worktree)) {
    throw new Error(`test cleanup left the exact worktree behind: ${worktree}`);
  }
}

beforeEach(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
});

afterEach(async () => {
  try {
    await cleanupKnownWorktree();
  } finally {
    rmSync(FIXTURES, { recursive: true, force: true });
  }
});

describe("/new channel-registry epoch fence", { timeout: 60_000 }, () => {
  it("observes a disable that lands before thread creation and creates no thread", async () => {
    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(join(reposRoot, "repo", ".git"), { recursive: true });
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    expect(registry.enable(SECONDARY, OWNER)).toBe(true);
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as unknown as CopilotClient,
      new FakeTransport(),
      new SessionStore(join(FIXTURES, "sessions.json")),
      registry
    );
    const createThread = vi.fn(async () => ({ id: "thread-1", delete: async () => {} }));
    patchChannelFetch(app, async () => {
      expect(registry.disable(SECONDARY)).toBe(true);
      return {
        type: ChannelType.GuildText,
        threads: { create: createThread },
      };
    });
    const interaction = slash();

    await cmdNew(app, asInteraction(interaction));

    expect(interaction.defers).toHaveLength(1);
    expect(registry.has(SECONDARY)).toBe(false);
    expect(createThread).not.toHaveBeenCalled();
    expect(interaction.edits.join("\n")).toContain("被停用了");
  });

  it("deletes the thread and worktree when disable lands after worktree creation but before reserve", async () => {
    const reposRoot = join(FIXTURES, "repos");
    const repoPath = await makeRepo();
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    expect(registry.enable(SECONDARY, OWNER)).toBe(true);
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as unknown as CopilotClient,
      new FakeTransport(),
      store,
      registry
    );
    const branch = worktreeBranch(RACE_THREAD_ID);
    const expectedWorktree = worktreePath(worktreeRoot(), repoPath, RACE_THREAD_ID);
    cleanupRepo = repoPath;
    cleanupWorktree = expectedWorktree;
    cleanupBranch = branch;
    const deleteThread = vi.fn(async (): Promise<void> => {});
    const fakeThread = { id: RACE_THREAD_ID, delete: deleteThread };
    const createThread = vi.fn(async () => fakeThread);
    try {
      patchChannelFetch(app, async () => ({
        type: ChannelType.GuildText,
        threads: { create: createThread },
      }));
      patchBindingCheck(app, async (binding, deps) => {
        expect(binding).toMatchObject({
          repoPath,
          workDir: expectedWorktree,
          devMode: "worktree",
          branch,
        });
        expect(deps).toMatchObject({ reposRoot, worktreeRoot: worktreeRoot() });
        expect(existsSync(expectedWorktree)).toBe(true);
        expect(registry.disable(SECONDARY)).toBe(true);
        return { ok: true };
      });

      await cmdNew(app, asInteraction(slash()));

      expect(createThread).toHaveBeenCalledOnce();
      expect(deleteThread).toHaveBeenCalledOnce();
      expect(store.get(RACE_THREAD_ID)).toBeUndefined();
      expect(existsSync(expectedWorktree)).toBe(false);
    } finally {
      await cleanupKnownWorktree();
    }
  });

  it("does not mistake an unrelated channel mutation for disabling this new session's parent", async () => {
    const reposRoot = join(FIXTURES, "repos");
    const repoPath = await makeRepo();
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    expect(registry.enable(SECONDARY, OWNER)).toBe(true);
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const app = DiscordCopilotApp.createForTest(
      config(reposRoot),
      reposRoot,
      {} as unknown as CopilotClient,
      new FakeTransport(),
      store,
      registry
    );
    const branch = worktreeBranch(UNRELATED_RACE_THREAD_ID);
    const expectedWorktree = worktreePath(worktreeRoot(), repoPath, UNRELATED_RACE_THREAD_ID);
    cleanupRepo = repoPath;
    cleanupWorktree = expectedWorktree;
    cleanupBranch = branch;
    const deleteThread = vi.fn(async (): Promise<void> => {});
    const fakeThread = { id: UNRELATED_RACE_THREAD_ID, delete: deleteThread };
    const createThread = vi.fn(async () => {
      expect(registry.has(SECONDARY)).toBe(true);
      expect(registry.disable(SECONDARY)).toBe(true);
      return fakeThread;
    });
    const interaction = slash(SECONDARY);
    try {
      patchChannelFetch(app, async () => {
        expect(registry.enable(UNRELATED, OWNER)).toBe(true);
        return {
          type: ChannelType.GuildText,
          threads: { create: createThread },
        };
      });
      patchBindingCheck(app, async () => {
        expect(existsSync(expectedWorktree)).toBe(true);
        return { ok: true };
      });

      await cmdNew(app, asInteraction(interaction));

      expect(createThread).toHaveBeenCalledOnce();
      expect(registry.has(UNRELATED)).toBe(true);
      expect(registry.has(SECONDARY)).toBe(false);
      expect(deleteThread).toHaveBeenCalledOnce();
      expect(store.get(UNRELATED_RACE_THREAD_ID)).toBeUndefined();
      expect(existsSync(expectedWorktree)).toBe(false);
      expect(interaction.edits.join("\n")).not.toContain("這期間被停用了，沒有建立 session");
      expect(interaction.edits.join("\n")).toContain("已回復");
    } finally {
      await cleanupKnownWorktree();
    }
  });
});

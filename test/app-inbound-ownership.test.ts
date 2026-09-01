import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import type { CopilotClient } from "@github/copilot-sdk";
import { DiscordCopilotApp } from "../src/app.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import { SessionStore } from "../src/core/session-store.js";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import type { InstanceLock } from "../src/core/single-instance.js";
import type { OwnedScope } from "../src/core/lifecycle-ownership.js";
import { removeWorktreeIfClean, worktreeBranch, worktreePath } from "../src/core/worktree.js";
import { worktreeRoot } from "../src/core/paths.js";
import type { Config } from "../src/config.js";
import { tryOwnedScope } from "./support/owned-scope.js";
import { strictInteraction, asCommandInteraction } from "./support/strict-interaction.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import { encodePermissionId } from "../src/platforms/discord/custom-id.js";

/**
 * Ownership of MUTATING inbound operations.
 *
 * The phase gate at the top of `onInteraction` is synchronous: it says only that
 * shutdown had not begun when the event arrived. Everything after it is awaits —
 * a channel fetch, a `git worktree add`, an SDK create, a registry write — and a
 * signal landing in one of those gaps used to let the coordinator conclude that
 * nothing was in flight and release the single-instance lock while the operation
 * was still building things. Each handler now holds an `OwnedScope` keyed by the
 * interaction/message id, so the release waits, and each checks `lostReason()`
 * after its awaits so it rolls back through the path it already had.
 *
 * The key is per OPERATION, never per thread: `runExclusive(threadId)` would
 * serialize two commands in one thread that run concurrently today, and would be
 * declined by an `/end` teardown claim on that thread.
 */

const OWNER = "10000";
const GUILD = "20000";
const SEED = "30000";
const FIXTURES = join(process.cwd(), ".test-fixtures-inbound-ownership");
const NEW_THREAD_ID = `inbound-new-${process.pid}`;
const run = promisify(execFile);

let cleanupRepo: string | undefined;
let cleanupWorktree: string | undefined;
let cleanupBranch: string | undefined;

class FakeTransport implements Transport {
  notices: string[] = [];
  async render(): Promise<void> {}
  async sendFile(..._args: Parameters<Transport["sendFile"]>): Promise<SendFileResult> {
    return { ok: false, reason: "unavailable" };
  }
  async showPermission(): Promise<void> {}
  async showUserInput(): Promise<void> {}
  async showPlan(): Promise<void> {}
  async notice(_k: string, t: string): Promise<void> {
    this.notices.push(t);
  }
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
  } as unknown as Config;
}

function fakeCopilot(): CopilotClient {
  return {
    async createSession() {
      return {
        sessionId: "s",
        on(): void {},
        async send(): Promise<void> {},
        async abort(): Promise<void> {},
        async disconnect(): Promise<void> {},
        rpc: { plan: { readSqlTodosWithDependencies: async () => ({ rows: [], dependencies: [] }) } },
      };
    },
    async stop(): Promise<Error[]> {
      return [];
    },
  } as unknown as CopilotClient;
}

/** An app whose coordinator holds a lock the test can watch, with a short join
 *  bound so a `stop()` that cannot join does not stall the suite. */
function appWith(
  reposRoot: string,
  store: SessionStore,
  registry: ChannelRegistry
): { app: DiscordCopilotApp; transport: FakeTransport; releases: () => number; events: string[] } {
  const transport = new FakeTransport();
  const app = DiscordCopilotApp.createForTest(
    config(reposRoot),
    reposRoot,
    fakeCopilot(),
    transport,
    store,
    registry
  );
  const events: string[] = [];
  let releases = 0;
  const lock: InstanceLock = {
    path: "(test)",
    release: async () => {
      releases++;
      events.push("lock-released");
    },
  };
  (
    app as unknown as {
      useOwnershipForTest(l: InstanceLock, o: Record<string, unknown>): void;
    }
  ).useOwnershipForTest(lock, { joinTimeoutMs: 3_000, obligationTimeoutMs: 200 });
  return { app, transport, releases: () => releases, events };
}

const slash = (channelId: string) =>
  strictInteraction({
    user: { id: OWNER },
    guildId: GUILD,
    channelId,
    channel: { isThread: () => false },
    options: { getSubcommand: () => "new", getString: () => null, getBoolean: () => null },
  });

function patchChannelFetch(app: DiscordCopilotApp, fetch: (id: string) => Promise<unknown>): void {
  (
    app as unknown as { discord: { channels: { fetch(id: string): Promise<unknown> } } }
  ).discord.channels.fetch = fetch;
}
function patchBindingCheck(app: DiscordCopilotApp, check: () => Promise<{ ok: true }>): void {
  (app as unknown as { bindingCheck: unknown }).bindingCheck = check;
}

const cmdNew = (
  app: DiscordCopilotApp,
  interaction: ChatInputCommandInteraction,
  scope: OwnedScope
): Promise<void> =>
  (
    app as unknown as {
      cmdNew(i: ChatInputCommandInteraction, s: OwnedScope): Promise<void>;
    }
  ).cmdNew(interaction, scope);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

async function makeRepo(): Promise<string> {
  const repo = join(FIXTURES, "repos", "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@example.invalid");
  await git(repo, "config", "user.name", "Inbound ownership test");
  writeFileSync(join(repo, "README.md"), "x\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function cleanupKnownWorktree(): Promise<void> {
  const repo = cleanupRepo;
  const worktree = cleanupWorktree;
  const branch = cleanupBranch;
  cleanupRepo = cleanupWorktree = cleanupBranch = undefined;
  if (!repo || !worktree || !branch || !existsSync(worktree)) return;
  const outcome = await removeWorktreeIfClean(repo, worktree, branch);
  if (outcome !== "removed" && existsSync(worktree)) {
    await git(repo, "worktree", "remove", "--force", worktree);
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

describe("/new is owned work", { timeout: 60_000 }, () => {
  it("rolls the whole transaction back when shutdown lands after the worktree exists", async () => {
    const reposRoot = join(FIXTURES, "repos");
    const repoPath = await makeRepo();
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    expect(registry.enable(SEED, OWNER)).toBe(true);
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const { app, releases, events } = appWith(reposRoot, store, registry);
    const branch = worktreeBranch(NEW_THREAD_ID);
    const expectedWorktree = worktreePath(worktreeRoot(), repoPath, NEW_THREAD_ID);
    cleanupRepo = repoPath;
    cleanupWorktree = expectedWorktree;
    cleanupBranch = branch;
    const deleteThread = vi.fn(async (): Promise<void> => {});
    const createThread = vi.fn(async () => ({ id: NEW_THREAD_ID, delete: deleteThread }));
    patchChannelFetch(app, async () => ({
      type: ChannelType.GuildText,
      threads: { create: createThread },
    }));

    let stopping: Promise<void> | undefined;
    // The binding proof runs immediately AFTER `git worktree add`, so this is
    // the exact window a SIGTERM is worst in: a real checkout exists on disk and
    // nothing durable points at it yet.
    patchBindingCheck(app, async () => {
      expect(existsSync(expectedWorktree)).toBe(true);
      stopping = app.stop().catch(() => {});
      return { ok: true };
    });
    const interaction = slash(SEED);

    const outcome = await tryOwnedScope(app, (scope) =>
      cmdNew(app, asCommandInteraction(interaction), scope)
    );
    expect(outcome.ran).toBe(true);
    events.push("new-settled");

    await stopping;

    // Rolled back through the paths `/new` already had, and nothing durable or
    // live was created.
    expect(existsSync(expectedWorktree)).toBe(false);
    expect(deleteThread).toHaveBeenCalledOnce();
    expect(store.get(NEW_THREAD_ID)).toBeUndefined();
    expect(
      (app as unknown as { sessions: Map<string, unknown> }).sessions.has(NEW_THREAD_ID)
    ).toBe(false);
    expect(interaction.answers.join("\n")).toContain("關閉中");
    // …and the lock waited for the rollback rather than being released while a
    // checkout still existed.
    expect(releases()).toBe(1);
    expect(events.indexOf("lock-released")).toBeGreaterThan(events.indexOf("new-settled"));
  });

  it("declines before doing anything at all when shutdown already finished", async () => {
    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(join(reposRoot, "repo", ".git"), { recursive: true });
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const { app } = appWith(reposRoot, store, registry);
    const createThread = vi.fn(async () => ({ id: "never", delete: async () => {} }));
    patchChannelFetch(app, async () => ({
      type: ChannelType.GuildText,
      threads: { create: createThread },
    }));
    await app.stop();

    const outcome = await tryOwnedScope(app, (scope) =>
      cmdNew(app, asCommandInteraction(slash(SEED)), scope)
    );

    expect(outcome.ran).toBe(false);
    expect(createThread).not.toHaveBeenCalled();
  });
});

describe("/channel is owned work", () => {
  it("writes nothing to the registry when shutdown lands before the commit", async () => {
    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(reposRoot, { recursive: true });
    const registryFile = join(FIXTURES, "channels.json");
    const registry = new ChannelRegistry(SEED, GUILD, registryFile);
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const { app } = appWith(reposRoot, store, registry);
    const target = "99999";
    // The permission audit is the long await between "the operator asked" and
    // the durable write. A registry widened here would grant a channel nobody is
    // left to answer in.
    let stopping: Promise<void> | undefined;
    (app as unknown as { inspectChannelTarget: unknown }).inspectChannelTarget = async () => {
      stopping = app.stop().catch(() => {});
      return { missing: [] };
    };
    const interaction = strictInteraction({
      user: { id: OWNER },
      guildId: GUILD,
      channelId: SEED,
      channel: { isThread: () => false },
      options: { getSubcommand: () => "enable", getString: () => target, getBoolean: () => null },
    });

    await tryOwnedScope(app, (scope) =>
      (
        app as unknown as {
          cmdChannel(i: ChatInputCommandInteraction, s: OwnedScope): Promise<void>;
        }
      ).cmdChannel(asCommandInteraction(interaction), scope)
    );
    await stopping;

    expect(registry.has(target)).toBe(false);
    expect(new ChannelRegistry(SEED, GUILD, registryFile).has(target)).toBe(false);
    expect(interaction.answers.join("\n")).toContain("關閉中");
  });
});

describe("read-only commands need no scope", () => {  it("still answers /sessions with the coordinator holding nothing", async () => {
    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(reposRoot, { recursive: true });
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const { app } = appWith(reposRoot, store, registry);
    const interaction = strictInteraction({
      user: { id: OWNER },
      guildId: GUILD,
      channelId: SEED,
      channel: { isThread: () => false },
      options: { getSubcommand: () => "list", getString: () => null, getBoolean: () => null },
    });

    await (
      app as unknown as { cmdSessions(i: ChatInputCommandInteraction): Promise<void> }
    ).cmdSessions(asCommandInteraction(interaction));

    expect(interaction.answers).toHaveLength(1);
    const inspector = (
      app as unknown as { ownershipInspector: { exclusiveThreads(): string[] } }
    ).ownershipInspector;
    expect(inspector.exclusiveThreads()).toEqual([]);
  });
});


describe("a button click is owned work", () => {
  it("settles the SAFE default when shutdown lands across the Discord ack", async () => {
    // The ack is a network round trip. Delivering the operator's Allow after a
    // shutdown began would hand the SDK a shell command to start while teardown
    // is already walking the sessions.
    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(reposRoot, { recursive: true });
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const { app } = appWith(reposRoot, store, registry);
    const threadId = "t-btn";
    const broker = new PendingInteractionBroker();
    const decided: Array<{ nonce: string; decision: string }> = [];
    const session = {
      actor: {} as never,
      broker,
      running: false,
      titled: true,
      titleEpoch: 0,
      queue: [],
      workDir: reposRoot,
      repoPath: reposRoot,
      devMode: "local" as const,
      parentChannelId: SEED,
      hasRunTurn: true,
    };
    (app as unknown as { sessions: Map<string, unknown> }).sessions.set(threadId, session);
    const settled = broker.register<string>({
      sessionKey: threadId,
      generation: 1,
      kind: "shell",
      timeoutMs: 60_000,
      onDefault: () => "deny",
    });
    (
      app as unknown as { transport: { deliverDecision(n: string, d: string): void } }
    ).transport.deliverDecision = (nonce, decision) => {
      decided.push({ nonce, decision });
      broker.settle(nonce, decision);
    };

    let stopping: Promise<void> | undefined;
    const interaction = {
      id: "btn-1",
      customId: encodePermissionId(settled.nonce, "always"),
      user: { id: OWNER },
      guildId: GUILD,
      channelId: threadId,
      channel: { isThread: () => true, parentId: SEED },
      isButton: () => true,
      async update(): Promise<void> {
        stopping = app.stop().catch(() => {});
        await Promise.resolve();
      },
      async reply(): Promise<void> {},
    };

    await tryOwnedScope(app, (scope) =>
      (
        app as unknown as {
          onButton(i: unknown, s: OwnedScope): Promise<void>;
        }
      ).onButton(interaction, scope)
    );
    await stopping;

    // The click was acknowledged and then answered with the fail-closed default,
    // never with the widening "always" the operator pressed.
    expect(decided).toEqual([{ nonce: settled.nonce, decision: "deny" }]);
    await expect(settled.promise).resolves.toBe("deny");
  });
});

describe("a thread message is owned work", () => {
  it("starts no turn when shutdown lands before the SDK work", async () => {
    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(reposRoot, { recursive: true });
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const { app } = appWith(reposRoot, store, registry);
    const threadId = "t-msg";
    (app as unknown as { phase: string }).phase = "ready";
    const session = {
      actor: {
        tryConsumeFreeform: () => false,
        isAwaitingFreeform: () => false,
      } as never,
      broker: new PendingInteractionBroker(),
      running: false,
      titled: true,
      titleEpoch: 0,
      queue: [],
      workDir: reposRoot,
      repoPath: reposRoot,
      devMode: "local" as const,
      parentChannelId: SEED,
      hasRunTurn: true,
    };
    (app as unknown as { sessions: Map<string, unknown> }).sessions.set(threadId, session);
    const turns: string[] = [];
    (app as unknown as { runTurn(t: string, x: string): Promise<void> }).runTurn = async (_t, x) => {
      turns.push(x);
    };
    let stopping: Promise<void> | undefined;
    // `startTitling` is the last thing before the turn; a signal here is the
    // realistic schedule (the titler is itself an RPC).
    (app as unknown as { startTitling(): void }).startTitling = () => {
      stopping = app.stop().catch(() => {});
    };
    const message = {
      id: "m-1",
      author: { bot: false, id: OWNER },
      channelId: threadId,
      guildId: GUILD,
      channel: { isThread: () => true, parentId: SEED },
      content: "hello",
      attachments: { size: 0 },
    };

    await tryOwnedScope(app, (scope) =>
      (app as unknown as { onMessage(m: unknown, s: OwnedScope): Promise<void> }).onMessage(
        message,
        scope
      )
    );
    await stopping;

    expect(turns).toEqual([]); // no new SDK work started into a dying process
  });
});

describe("teardown commands are NOT wrapped, and do not deadlock", () => {
  it("lets /end run its own teardown claim while an unrelated operation is owned", async () => {
    // `/end` and rebind claim their THREAD through `runTeardown`. Wrapping them
    // in an exclusive scope as well would make their own `joinExclusive` wait
    // for themselves. This proves the two coexist: an owned inbound operation is
    // in flight the whole time, keyed by operation, and `/end` still completes.
    const reposRoot = join(FIXTURES, "repos");
    mkdirSync(reposRoot, { recursive: true });
    const registry = new ChannelRegistry(SEED, GUILD, join(FIXTURES, "channels.json"));
    const store = new SessionStore(join(FIXTURES, "sessions.json"));
    const { app } = appWith(reposRoot, store, registry);
    const threadId = "t-end";
    store.reserve({
      threadId,
      sessionId: "s-end",
      generation: 1,
      repoPath: join(reposRoot, "repo"),
      guildId: GUILD,
      parentChannelId: SEED,
      workDir: join(reposRoot, "repo"),
      devMode: "local",
    });
    store.commit(threadId);
    store.setState(threadId, "blocked", "thread-gone");

    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const owned = tryOwnedScope(app, async () => {
      await held;
    });

    const interaction = strictInteraction({
      user: { id: OWNER },
      guildId: GUILD,
      channelId: SEED,
      channel: { isThread: () => false },
      options: { getSubcommand: () => "end", getString: () => threadId, getBoolean: () => null },
    });
    await (
      app as unknown as { endStaleRecord(i: unknown, t: string): Promise<void> }
    ).endStaleRecord(asCommandInteraction(interaction), threadId);

    expect(store.get(threadId)).toBeUndefined(); // the reclaim really ran
    release();
    await owned;
  });
});
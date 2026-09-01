import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DiscordCopilotApp, type Session } from "../src/app.js";
import { SessionStore } from "../src/core/session-store.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import { addWorktree } from "../src/core/worktree.js";
import { canonicalPathOr } from "../src/core/repo.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { ChatInputCommandInteraction } from "discord.js";
import { SessionActor, type SessionActorOpts } from "../src/copilot/session-actor.js";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import type { DevMode } from "../src/core/binding.js";
import type { SecureOpenBackend } from "../src/core/secure-open.js";
import { worktreePath } from "../src/core/worktree.js";
import { worktreeRoot } from "../src/core/paths.js";
import type { InstanceLock } from "../src/core/single-instance.js";
import {
  strictInteraction,
  asCommandInteraction,
  type StrictInteraction,
  type StrictInteractionFields,
} from "./support/strict-interaction.js";
import {
  appTestDependencies,
  type AppTestDependencyOverrides,
} from "./support/app-test-dependencies.js";

const run = promisify(execFile);

/**
 * App-level tests for the repo-rebind state machine.
 *
 * Rebinding is the one operation here that DESTROYS something (the conversation)
 * and touches four resources at once — a worktree, a durable record, a live SDK
 * session and a repo lease. The Council review found two real defects in it that
 * no test would have caught, so the invariants are pinned here rather than left
 * to reading.
 *
 * The git-backed binding proof is injected: it has its own suite against real
 * worktrees (`binding.test.ts`), and requiring real repos here would test git
 * rather than the orchestration.
 */

class FakeActor {
  disconnectCalls = 0;
  disconnectFails = false;
  suspendFileDeliveryCalls = 0;
  resumeFileDeliveryCalls: number[] = [];
  onSuspendFileDelivery?: () => void;
  onDisconnect?: () => void;
  disconnectGate?: Promise<void>;
  oldQuotaReserve?: boolean;
  isFaulted(): boolean {
    return false;
  }
  generationOf(): number {
    return 1;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.onDisconnect?.();
    if (this.disconnectGate) await this.disconnectGate;
    if (this.disconnectFails) throw new Error("runtime did not answer");
  }
  async stop(): Promise<boolean> {
    return true;
  }
  suspendFileDelivery(): number {
    this.suspendFileDeliveryCalls++;
    this.onSuspendFileDelivery?.();
    return this.suspendFileDeliveryCalls;
  }
  resumeFileDeliveryIfCurrent(fence: number): boolean {
    this.resumeFileDeliveryCalls.push(fence);
    return true;
  }
}

class FakeTransport implements Transport {
  notices: Array<{ key: string; text: string }> = [];
  async render(): Promise<void> {}
  async sendFile(..._args: Parameters<Transport["sendFile"]>): Promise<SendFileResult> {
    return { ok: false, reason: "unavailable" };
  }
  async showPermission(): Promise<void> {}
  async showUserInput(): Promise<void> {}
  async showPlan(): Promise<void> {}
  async notice(k: string, t: string): Promise<void> {
    this.notices.push({ key: k, text: t });
  }
  async noticeDelivered(k: string, t: string): Promise<boolean> {
    this.notices.push({ key: k, text: t });
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

let tmp: string;
let reposRoot: string;
let repoA: string;
let repoB: string;
let storeFile: string;

const cfg = (): Parameters<typeof DiscordCopilotApp.createForTest>[0] =>
  ({
    DISCORD_BOT_TOKEN: "t",
    DISCORD_ALLOWED_USER_IDS: ["u1"],
    DISCORD_GUILD_ID: "g1",
    DISCORD_PARENT_CHANNEL_ID: "c1",
    REPOS_ROOT: reposRoot,
    DEFAULT_MODEL: "claude-sonnet-5",
    DEFAULT_CONTEXT_TIER: "default",
    REPO_CLONE_HOST_POLICY: "github",
    REPO_CLONE_ALLOWED_HOSTS: [],
    REPO_CLONE_TIMEOUT_MS: 300_000,
  }) as unknown as Parameters<typeof DiscordCopilotApp.createForTest>[0];

/** A copilot client whose createSession always succeeds, unless told not to. */
function fakeCopilot(opts: { createFails?: boolean } = {}): CopilotClient {
  return {
    async createSession() {
      if (opts.createFails) throw new Error("runtime refused");
      return { on() {}, async send() {}, async disconnect() {} };
    },
    async stop(): Promise<Error[]> {
      return [];
    },
  } as unknown as CopilotClient;
}

async function createActiveActor(workDir: string, transport: Transport): Promise<SessionActor> {
  return SessionActor.createForTest(
    fakeCopilot(),
    {
      sessionKey: "t1",
      workingDirectory: workDir,
      broker: new PendingInteractionBroker(),
      transport,
      policy: new ApprovalPolicy(path.join(tmp, `approvals-${Math.random()}.json`)),
      initialFileDeliveryBytes: 0,
      fileDeliverySessionId: "s1",
      reserveFileDeliveryBytes: () => true,
    },
    {
      // Required: both default to the home of whoever runs this suite.
      auditLog: { append: () => true },
      skillsHomeDirectory: path.join(tmp, "no-user-skills"),
    }
  );
}

interface Harness {
  app: DiscordCopilotApp;
  store: SessionStore;
  transport: FakeTransport;
  actor: FakeActor;
}

function testChannels(): ChannelRegistry {
  return new ChannelRegistry("c1", "g1", path.join(tmp, "channels.json"));
}

/** The dependency object `createForTest` requires, sourced from this suite's
 *  per-test temporary root instead of the home directory of whoever runs it. */
const appDependencies = (over: AppTestDependencyOverrides): ReturnType<typeof appTestDependencies> =>
  appTestDependencies({ directory: tmp, parentChannelId: "c1", guildId: "g1" }, over);

function harness(
  over: {
    devMode?: DevMode;
    repo?: string;
    hasRunTurn?: boolean;
    createFails?: boolean;
    parentChannelId?: string;
    channels?: ChannelRegistry;
  } = {}
): Harness {
  const transport = new FakeTransport();
  const store = new SessionStore(storeFile);
  const app = DiscordCopilotApp.createForTest(
    cfg(),
    reposRoot,
    fakeCopilot(over),
    transport,
    appDependencies({ store, channels: over.channels ?? testChannels() })
  );
  const actor = new FakeActor();
  const devMode = over.devMode ?? "local";
  const repo = over.repo ?? repoA;
  const parentChannelId = over.parentChannelId ?? "c1";
  const session: Session = {
    actor: actor as unknown as Session["actor"],
    broker: new PendingInteractionBroker(),
    running: false,
    titled: true,
    titleEpoch: 0,
    queue: [],
    workDir: repo,
    repoPath: repo,
    devMode,
    parentChannelId,
    hasRunTurn: over.hasRunTurn ?? true,
  };
  store.reserve({
    threadId: "t1",
    sessionId: "s1",
    generation: 1,
    repoPath: repo,
    guildId: "g1",
    parentChannelId,
    workDir: repo,
    devMode,
  });
  store.commit("t1");
  sessions(app).set("t1", session);
  if (devMode === "local") leases(app).set(leaseKeyOf(repo), "t1");
  // Bypass the git proof — see the file header.
  (app as unknown as { bindingCheck: unknown }).bindingCheck = async () => ({ ok: true });
  return { app, store, transport, actor };
}

const sessions = (app: DiscordCopilotApp): Map<string, Session> =>
  (app as unknown as { sessions: Map<string, Session> }).sessions;
const leases = (app: DiscordCopilotApp): Map<string, string> =>
  (app as unknown as { localLeases: Map<string, string> }).localLeases;
const staleRebindActors = (app: DiscordCopilotApp): Map<SessionActor, unknown> =>
  (app as unknown as { staleRebindActors: Map<SessionActor, unknown> }).staleRebindActors;
const staleRebinds = (store: SessionStore): ReturnType<SessionStore["all"]> =>
  (
    store as unknown as {
      staleRebinds(): ReturnType<SessionStore["all"]>;
    }
  ).staleRebinds();
const retryStaleRebinds = (app: DiscordCopilotApp): Promise<void> =>
  (
    app as unknown as {
      retryStaleRebindActorsForThread(threadId: string): Promise<void>;
    }
  ).retryStaleRebindActorsForThread("t1");
/** Mirrors `DiscordCopilotApp.leaseKey`: the SAME canonicaliser, case-folded on
 *  Windows ONLY. Using `path.resolve().toLowerCase()` here made the assertions
 *  pass locally and fail on CI twice — once for the case rule on Linux, once
 *  because a short-name tmpdir canonicalises to a different string. */
const leaseKeyOf = (p: string): string =>
  process.platform === "win32" ? canonicalPathOr(p).toLowerCase() : canonicalPathOr(p);
const applyRebind = (app: DiscordCopilotApp, target: { repoPath: string; devMode: DevMode }): Promise<string> =>
  (
    app as unknown as {
      applyRebind(t: string, x: { repoPath: string; devMode: DevMode }): Promise<string>;
    }
  ).applyRebind("t1", target);
const beginRebind = (
  app: DiscordCopilotApp,
  interaction: StrictInteraction & StrictInteractionFields,
  want: { repoPath?: string; devMode?: DevMode },
  opts: { alreadyReplied?: boolean } = {}
): Promise<void> =>
  (
    app as unknown as {
      beginRebind(
        i: ChatInputCommandInteraction,
        w: { repoPath?: string; devMode?: DevMode },
        o: { alreadyReplied?: boolean }
      ): Promise<void>;
    }
  ).beginRebind(asCommandInteraction(interaction), want, opts);
const blocker = (
  app: DiscordCopilotApp,
  session: Session,
  target: { repoPath: string; devMode: DevMode }
): Promise<string | undefined> =>
  (
    app as unknown as {
      rebindBlocker(t: string, s: Session, x: { repoPath: string; devMode: DevMode }): Promise<string | undefined>;
    }
  ).rebindBlocker("t1", session, target);

function endInteraction(): ChatInputCommandInteraction {
  // The STRICT shared fake: it throws `InteractionAlreadyReplied` exactly where
  // discord.js does, so `/end`'s answer path cannot pass here while failing in
  // production. The permissive local fake this replaced was the reason a
  // reply-after-defer went unnoticed.
  return asCommandInteraction(
    strictInteraction({
      user: { id: "u1" },
      guildId: "g1",
      channelId: "t1",
      channel: { isThread: () => true, parentId: "c1" },
      options: { getString: () => null },
    })
  );
}

const endThread = (app: DiscordCopilotApp): Promise<void> =>
  (
    app as unknown as {
      cmdEnd(i: ChatInputCommandInteraction): Promise<void>;
    }
  ).cmdEnd(endInteraction());

/** The coordinator's read-only view of the sets its release conclusion is drawn
 *  from. A detached rebind incarnation this process could not prove stopped is
 *  an OBLIGATION here, keyed by its DURABLE identity. */
type Inspector = {
  exclusiveThreads(): string[];
  teardownClaims(): string[];
  obligationKeys(): string[];
  obligation(key: string): unknown;
  released(): boolean;
};
function inspectOwnership(app: DiscordCopilotApp): Inspector {
  const inspector = (app as unknown as { ownershipInspector?: Inspector }).ownershipInspector;
  if (!inspector) throw new Error("this app was not built with the test ownership seam");
  return inspector;
}
/** Give the app a lock the test can watch. The lock lives INSIDE the lifecycle
 *  coordinator — the only thing allowed to release it — so the only honest way
 *  to count releases is to hand that coordinator an observable lock. */
function useObservableLock(app: DiscordCopilotApp, lock: InstanceLock): void {
  (app as unknown as { useOwnershipForTest(l: InstanceLock): void }).useOwnershipForTest(lock);
}
/** …and its log, for the shutdown messages that are supposed to be true. */
function useObservableOwnership(
  app: DiscordCopilotApp,
  lock: InstanceLock,
  log: (m: string) => void
): void {
  (
    app as unknown as {
      useOwnershipForTest(l: InstanceLock, o: { log(m: string): void }): void;
    }
  ).useOwnershipForTest(lock, { log });
}
const staleRebindKey = (b: { threadId: string; sessionId: string; generation: number }): string =>
  `stale-rebind:${b.threadId}:${b.sessionId}:${b.generation}`;
/** The invariant the two indexes must agree on: anything the app still holds a
 *  strong reference to must also be something the coordinator is owed. An entry
 *  in one and not the other is exactly how a live runtime kept a checkout while
 *  the process lock was free to go. */
function assertEveryRetainedRuntimeIsOwed(app: DiscordCopilotApp): void {
  const keys = inspectOwnership(app).obligationKeys();
  for (const entry of staleRebindActors(app).values()) {
    const binding = (entry as { binding: { threadId: string; sessionId: string; generation: number } })
      .binding;
    expect(keys, `retained stale incarnation ${binding.sessionId} is not owed`).toContain(
      staleRebindKey(binding)
    );
  }
}

/** A REAL git repo: the rebind path runs `git worktree add`, `git status` and
 *  `git symbolic-ref` for real, and a `.git` directory alone makes all of them
 *  fail — which the code correctly treats as "refuse to touch anything". */
async function mkRepo(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main", dir]);
  await run("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@localhost",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@localhost",
    },
  });
  return dir;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-rebind-"));
  reposRoot = path.join(tmp, "Repos");
  fs.mkdirSync(reposRoot, { recursive: true });
  repoA = await mkRepo(reposRoot, "alpha");
  repoB = await mkRepo(reposRoot, "beta");
  storeFile = path.join(tmp, "store.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("rebindBlocker — the preconditions that protect work", { timeout: 60_000 }, () => {
  it("refuses while a turn is running", async () => {
    const { app } = harness();
    const s = sessions(app).get("t1")!;
    s.running = true;
    expect(await blocker(app, s, { repoPath: repoB, devMode: "local" })).toMatch(/執行中/);
  });

  it("refuses while messages are queued", async () => {
    const { app } = harness();
    const s = sessions(app).get("t1")!;
    s.queue = ["later"];
    expect(await blocker(app, s, { repoPath: repoB, devMode: "local" })).toMatch(/佇列/);
  });

  it("refuses a local target another thread already holds, naming that thread", async () => {
    const { app } = harness();
    leases(app).set(leaseKeyOf(repoB), "other-thread");
    const msg = await blocker(app, sessions(app).get("t1")!, { repoPath: repoB, devMode: "local" });
    expect(msg).toMatch(/other-thread/);
    expect(msg).toMatch(/local/);
  });

  it("allows a WORKTREE target on a repo held in local mode by someone else", async () => {
    // The lease exists because two agents cannot share ONE checkout. A worktree
    // is a different checkout, so the restriction must not leak onto it.
    const { app } = harness();
    leases(app).set(leaseKeyOf(repoB), "other-thread");
    expect(await blocker(app, sessions(app).get("t1")!, { repoPath: repoB, devMode: "worktree" })).toBeUndefined();
  });
});

describe("/end local lease durability", { timeout: 60_000 }, () => {
  it("keeps the local lease through record removal so a concurrent admission cannot claim the checkout", async () => {
    const { app, store } = harness({ devMode: "local", repo: repoA });
    const originalRemove = store.remove.bind(store);
    const acquire = app as unknown as {
      acquireLocalLease(repoPath: string, threadId: string): { ok: true } | { ok: false; holder: string };
    };
    let admission: { ok: true } | { ok: false; holder: string } | undefined;
    const removeSpy = vi.spyOn(store, "remove").mockImplementation((threadId) => {
      admission = acquire.acquireLocalLease(repoA, "competing-thread");
      return originalRemove(threadId);
    });

    try {
      await endThread(app);

      expect(admission).toEqual({ ok: false, holder: "t1" });
      expect(leases(app).get(leaseKeyOf(repoA))).toBeUndefined();
      expect(acquire.acquireLocalLease(repoA, "competing-thread")).toEqual({ ok: true });
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("preserves the local lease and reports a durable removal failure safely", async () => {
    const { app, store } = harness({ devMode: "local", repo: repoA });
    const removeSpy = vi.spyOn(store, "remove").mockReturnValue(false);
    const edits: string[] = [];
    const interaction = {
      ...endInteraction(),
      editReply: async (value: string | { content: string }) => {
        edits.push(typeof value === "string" ? value : value.content);
      },
    } as unknown as ChatInputCommandInteraction;
    const acquire = app as unknown as {
      acquireLocalLease(repoPath: string, threadId: string): { ok: true } | { ok: false; holder: string };
    };

    try {
      await (
        app as unknown as {
          cmdEnd(i: ChatInputCommandInteraction): Promise<void>;
        }
      ).cmdEnd(interaction);

      expect(store.get("t1")?.state).toBe("active");
      expect(leases(app).get(leaseKeyOf(repoA))).toBe("t1");
      expect(acquire.acquireLocalLease(repoA, "competing-thread")).toEqual({ ok: false, holder: "t1" });
      expect(edits.join("\n")).toMatch(/無法寫入磁碟/);
    } finally {
      removeSpy.mockRestore();
    }
  });
});

describe("applyRebind — the transaction", { timeout: 60_000 }, () => {
  it("moves the lease when going local → local on a DIFFERENT repo", async () => {
    // The first version only released the lease when the TARGET was not local,
    // so this left the thread holding the repo it had just left — blocking every
    // other thread from it for the life of the process.
    const { app } = harness({ devMode: "local", repo: repoA });
    const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });
    expect(out).toMatch(/已改綁/);
    expect(leases(app).get(leaseKeyOf(repoA))).toBeUndefined();
    expect(leases(app).get(leaseKeyOf(repoB))).toBe("t1");
  });

  it("releases the lease when leaving local mode", async () => {
    const { app } = harness({ devMode: "local", repo: repoA });
    await applyRebind(app, { repoPath: repoA, devMode: "worktree" });
    expect(leases(app).get(leaseKeyOf(repoA))).toBeUndefined();
  });

  it("refuses a SECOND concurrent rebind on the same thread", async () => {
    // Two runs would each create a session and each `sessions.set`, leaving the
    // loser's SDK session live and referenced by nothing.
    const { app } = harness();
    const first = applyRebind(app, { repoPath: repoB, devMode: "local" });
    const second = await applyRebind(app, { repoPath: repoA, devMode: "worktree" });
    expect(second).toMatch(/已經有一個改綁在進行中/);
    await first;
  });

  it("leaves EVERYTHING as it was when the new session cannot be created", async () => {
    const transport = new FakeTransport();
    const store = new SessionStore(storeFile);
    const app = DiscordCopilotApp.createForTest(
      cfg(),
      reposRoot,
      fakeCopilot({ createFails: true }),
      transport,
      appDependencies({ store, channels: testChannels() })
    );
    const actor = new FakeActor();
    const session: Session = {
      actor: actor as unknown as Session["actor"],
      broker: new PendingInteractionBroker(),
      running: false,
      titled: true,
      titleEpoch: 0,
      queue: [],
      workDir: repoA,
      repoPath: repoA,
      devMode: "local",
      parentChannelId: "c1",
      hasRunTurn: true,
    };
    store.reserve({
      threadId: "t1",
      sessionId: "s1",
      generation: 1,
      repoPath: repoA,
      guildId: "g1",
      parentChannelId: "c1",
      workDir: repoA,
      devMode: "local",
    });
    store.commit("t1");
    sessions(app).set("t1", session);
    leases(app).set(leaseKeyOf(repoA), "t1");
    (app as unknown as { bindingCheck: unknown }).bindingCheck = async () => ({ ok: true });

    const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

    expect(out).toMatch(/失敗/);
    expect(out).toMatch(/原本的對話仍在/);
    expect(sessions(app).get("t1")).toBe(session); // old session still registered
    expect(actor.disconnectCalls).toBe(0); // old runtime untouched
    expect(store.get("t1")?.repoPath).toBe(repoA); // record rolled back
    expect(store.get("t1")?.sessionId).toBe("s1");
    expect(leases(app).get(leaseKeyOf(repoA))).toBe("t1"); // lease restored
    expect(leases(app).get(leaseKeyOf(repoB))).toBeUndefined();
  });

  it("retains and retries a replacement when commit failure cannot confirm its teardown", async () => {
    const { app, store, actor } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    const originalCreate = SessionActor.create;
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementDisconnect = vi.spyOn(replacement, "disconnect");
      replacementDisconnect.mockRejectedValueOnce(new Error("first teardown attempt unconfirmed"));
      return replacement;
    });
    const commitSpy = vi.spyOn(store, "commit").mockReturnValue(false);

    try {
      await expect(applyRebind(app, { repoPath: repoB, devMode: "worktree" })).resolves.toMatch(/commit 失敗/);

      expect(sessions(app).get("t1")?.actor).toBe(actor as unknown as Session["actor"]);
      expect(store.get("t1")?.sessionId).toBe("s1");
      await vi.waitFor(() => expect(replacementDisconnect).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          (app as unknown as { staleRebindActors: Map<SessionActor, unknown> }).staleRebindActors.size
        ).toBe(0)
      );
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      commitSpy.mockRestore();
      createSpy.mockRestore();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("reconciles a fallback reservation back to the live original only after the stale actor teardown confirms", async () => {
    const { app, store, actor } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    const originalCreate = SessionActor.create;
    const originalRetain = store.retainStaleRebind.bind(store);
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementDisconnect = vi
        .spyOn(replacement, "disconnect")
        .mockRejectedValue(new Error("replacement runtime remains live"));
      return replacement;
    });
    const commitSpy = vi.spyOn(store, "commit").mockReturnValue(false);
    const retainSpy = vi.spyOn(store, "retainStaleRebind").mockImplementation((binding, reason) => {
      if (reason === "rebind-teardown-unconfirmed" && binding.sessionId !== "s1") return false;
      return originalRetain(binding, reason);
    });

    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "worktree" });

      expect(out).toMatch(/安全屏障/);
      expect(sessions(app).get("t1")?.actor).toBe(actor as unknown as Session["actor"]);
      expect(store.get("t1")).toMatchObject({ repoPath: repoB, state: "creating" });
      expect(store.get("t1")?.sessionId).not.toBe("s1");
      expect(new SessionStore(storeFile).get("t1")).toMatchObject({ repoPath: repoB, state: "creating" });
      expect(staleRebindActors(app).size).toBe(1);
      expect([...staleRebindActors(app).values()][0]).toMatchObject({
        fallbackPrimary: {
          action: "restore",
          expectedTarget: {
            threadId: "t1",
            sessionId: store.get("t1")?.sessionId,
            generation: store.get("t1")?.generation,
          },
          original: { sessionId: "s1", generation: 1 },
        },
      });
      expect(fs.existsSync(targetWorktree)).toBe(true);
      expect(await blocker(app, sessions(app).get("t1")!, { repoPath: repoB, devMode: "local" })).toMatch(
        /安全屏障|清理/
      );

      await vi.waitFor(() => expect(replacementDisconnect).toHaveBeenCalledTimes(2));
      replacementDisconnect!.mockResolvedValue(undefined);
      await retryStaleRebinds(app);
      expect(replacementDisconnect).toHaveBeenCalledTimes(3);

      expect(sessions(app).get("t1")?.actor).toBe(actor as unknown as Session["actor"]);
      expect(store.get("t1")).toMatchObject({ sessionId: "s1", repoPath: repoA, state: "active" });
      expect(new SessionStore(storeFile).get("t1")).toMatchObject({ sessionId: "s1", repoPath: repoA, state: "active" });
      expect(staleRebinds(store)).toEqual([]);
      expect(staleRebindActors(app).size).toBe(0);
      expect(actor.resumeFileDeliveryCalls).toEqual([1]);
      expect(fs.existsSync(targetWorktree)).toBe(false);

      // Reconciliation is no longer an in-flight rebind. A later `/end` must
      // reclaim the restored primary record, not take the stale pre-swap path
      // and leave an active row that would resurrect on restart.
      await endThread(app);
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
    } finally {
      retainSpy.mockRestore();
      replacementDisconnect?.mockResolvedValue(undefined);
      await retryStaleRebinds(app);
      commitSpy.mockRestore();
      createSpy.mockRestore();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("keeps fallback ownership when conditional reconciliation cannot persist", async () => {
    const { app, store, actor } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    const originalCreate = SessionActor.create;
    const originalRetain = store.retainStaleRebind.bind(store);
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    let reconcileSpy: { mockRestore(): void } | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementDisconnect = vi
        .spyOn(replacement, "disconnect")
        .mockRejectedValue(new Error("replacement runtime remains live"));
      return replacement;
    });
    const commitSpy = vi.spyOn(store, "commit").mockReturnValue(false);
    const retainSpy = vi.spyOn(store, "retainStaleRebind").mockImplementation((binding, reason) => {
      if (reason === "rebind-teardown-unconfirmed" && binding.sessionId !== "s1") return false;
      return originalRetain(binding, reason);
    });

    try {
      await expect(applyRebind(app, { repoPath: repoB, devMode: "worktree" })).resolves.toMatch(/安全屏障/);
      const fallback = store.get("t1")!;
      reconcileSpy = vi
        .spyOn(store, "reconcileFallbackPrimary")
        .mockReturnValue({ ok: false, quotaAdvanced: false });
      replacementDisconnect!.mockResolvedValue(undefined);

      await retryStaleRebinds(app);

      expect(sessions(app).get("t1")?.actor).toBe(actor as unknown as Session["actor"]);
      expect(store.get("t1")).toMatchObject({
        sessionId: fallback.sessionId,
        generation: fallback.generation,
        state: "creating",
      });
      expect(staleRebindActors(app).size).toBe(1);
      expect(fs.existsSync(targetWorktree)).toBe(false);

      // Once `/end` wins, a second `/end` reaches endStaleRecord(). It must
      // retry the retained actor and refuse to reap the fallback primary while
      // the conditional persistence failure still owns that barrier.
      await endThread(app);
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toMatchObject({
        sessionId: fallback.sessionId,
        generation: fallback.generation,
        state: "creating",
      });
      await endThread(app);
      expect(store.get("t1")).toMatchObject({
        sessionId: fallback.sessionId,
        generation: fallback.generation,
        state: "creating",
      });
      expect(staleRebindActors(app).size).toBe(1);

      reconcileSpy.mockRestore();
      reconcileSpy = undefined;
      await retryStaleRebinds(app);
      expect(staleRebindActors(app).size).toBe(0);
      expect(store.get("t1")).toBeUndefined();
    } finally {
      reconcileSpy?.mockRestore();
      retainSpy.mockRestore();
      replacementDisconnect?.mockResolvedValue(undefined);
      await retryStaleRebinds(app);
      commitSpy.mockRestore();
      createSpy.mockRestore();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end retries an already-tracked fallback as removal after it wins", async () => {
    const { app, store } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    const originalCreate = SessionActor.create;
    const originalRetain = store.retainStaleRebind.bind(store);
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementDisconnect = vi
        .spyOn(replacement, "disconnect")
        .mockRejectedValue(new Error("replacement runtime remains live"));
      return replacement;
    });
    const commitSpy = vi.spyOn(store, "commit").mockReturnValue(false);
    const retainSpy = vi.spyOn(store, "retainStaleRebind").mockImplementation((binding, reason) => {
      if (reason === "rebind-teardown-unconfirmed" && binding.sessionId !== "s1") return false;
      return originalRetain(binding, reason);
    });

    try {
      await expect(applyRebind(app, { repoPath: repoB, devMode: "worktree" })).resolves.toMatch(/安全屏障/);
      expect(staleRebindActors(app).size).toBe(1);
      await vi.waitFor(() => expect(replacementDisconnect).toHaveBeenCalledTimes(2));
      replacementDisconnect!.mockResolvedValue(undefined);

      await endThread(app);

      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(staleRebinds(store)).toEqual([]);
      expect(staleRebindActors(app).size).toBe(0);
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      retainSpy.mockRestore();
      replacementDisconnect?.mockResolvedValue(undefined);
      await retryStaleRebinds(app);
      commitSpy.mockRestore();
      createSpy.mockRestore();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("suspends old file delivery before rebinding and restores it only after a failed rollback", async () => {
    const { app, actor, store } = harness({ createFails: true });
    expect(store.reserveFileDeliveryBytes("t1", "s1", 1, 0, 17)).toBe(true);

    const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

    expect(out).toMatch(/原本的對話仍在/);
    expect(actor.suspendFileDeliveryCalls).toBe(1);
    expect(actor.resumeFileDeliveryCalls).toEqual([1]);
    expect(store.get("t1")).toMatchObject({
      sessionId: "s1",
      generation: 1,
      fileDeliveryBytes: 17,
    });
    expect(new SessionStore(storeFile).get("t1")?.fileDeliveryBytes).toBe(17);
  });

  it("clears a failed rebind fence under YOLO so explicit /file stays available", async () => {
    const { app, transport } = harness({ createFails: true });
    const liveActor = await createActiveActor(repoA, transport);
    sessions(app).get("t1")!.actor = liveActor;
    liveActor.setYolo(true);

    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

      expect(out).toMatch(/原本的對話仍在/);
      expect(sessions(app).get("t1")?.actor).toBe(liveActor);
      expect(liveActor.canDeliverFiles()).toBe(true);
    } finally {
      await liveActor.disconnect().catch(() => {});
    }
  });

  it("clears a failed rebind fence during abort, but waits for the next turn to allow /file", async () => {
    const { app, transport } = harness({ createFails: true });
    const liveActor = await createActiveActor(repoA, transport);
    sessions(app).get("t1")!.actor = liveActor;
    await liveActor.stop();

    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

      expect(out).toMatch(/原本的對話仍在/);
      expect(liveActor.canDeliverFiles()).toBe(false);
      await liveActor.send("the normal lifecycle resumes");
      expect(liveActor.canDeliverFiles()).toBe(true);
    } finally {
      await liveActor.disconnect().catch(() => {});
    }
  });

  it("keeps the old actor file-fenced after a successful rebind", async () => {
    const { app, transport } = harness();
    const liveActor = await createActiveActor(repoA, transport);
    sessions(app).get("t1")!.actor = liveActor;

    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

      expect(out).toMatch(/已改綁/);
      expect(sessions(app).get("t1")?.actor).not.toBe(liveActor);
      expect(liveActor.canDeliverFiles()).toBe(false);
    } finally {
      const replacement = sessions(app).get("t1")?.actor;
      if (replacement && replacement !== liveActor) {
        await replacement.disconnect().catch(() => {});
      }
      await liveActor.disconnect().catch(() => {});
    }
  });

  it("keeps old file delivery fenced when failed rollback preserves a newer reservation", async () => {
    const { app, actor, store } = harness({ createFails: true });
    expect(store.reserveFileDeliveryBytes("t1", "s1", 1, 0, 17)).toBe(true);
    const originalCreate = SessionActor.create;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation((client, options) => {
      expect(
        store.reserveFileDeliveryBytes(
          "t1",
          options.fileDeliverySessionId,
          options.generation ?? 1,
          17,
          25
        )
      ).toBe(true);
      return originalCreate(client, options);
    });
    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

      expect(out).toMatch(/檔案傳送保持停用/);
      expect(actor.suspendFileDeliveryCalls).toBe(1);
      expect(actor.resumeFileDeliveryCalls).toEqual([]);
      expect(store.get("t1")).toMatchObject({
        sessionId: "s1",
        generation: 1,
        fileDeliveryBytes: 25,
      });
      expect(new SessionStore(storeFile).get("t1")?.fileDeliveryBytes).toBe(25);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("refuses when the binding cannot be proved, and touches nothing", async () => {
    const { app, store, actor } = harness();
    (app as unknown as { bindingCheck: unknown }).bindingCheck = async () => ({
      ok: false,
      problem: "worktree-owner-mismatch",
      detail: "belongs to another repo",
    });
    const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });
    expect(out).toMatch(/無法通過驗證/);
    expect(store.get("t1")?.repoPath).toBe(repoA);
    expect(actor.disconnectCalls).toBe(0);
  });

  it("hands the handle-bound validation path to git and rejects a root-swap model before actor creation", async () => {
    const { app, actor, transport } = harness();
    const restoredWorktreePath = "/repo/restored-worktree";
    const validationPath = "/proc/self/fd/97";
    const rootClose = vi.fn(async () => undefined);
    const backend: SecureOpenBackend = {
      open: vi.fn(async () => {
        throw new Error("this regression only captures a root");
      }),
      openDirectory: vi.fn(async () => ({
        // The attacker restores this mutable pathname to the expected target
        // before git runs. The descriptor path still names the external root
        // that was captured before the swap.
        finalPath: restoredWorktreePath,
        validationPath,
        identity: "outside-repo-root",
        directory: true,
        revalidate: async () => ({
          finalPath: restoredWorktreePath,
          identity: "outside-repo-root",
          directory: true,
        }),
        close: rootClose,
      })),
    };
    (
      app as unknown as {
        actorCreateDependencies?: {
          secureOpen?: { backend?: SecureOpenBackend; pathMode?: "win32" | "posix" };
          fileDeliveryPlatform?: NodeJS.Platform;
        };
      }
    ).actorCreateDependencies = {
      secureOpen: { backend, pathMode: "posix" },
      fileDeliveryPlatform: "win32",
    };
    const bindingCheck = vi.fn(async (binding: { workDir: string }) =>
      binding.workDir === validationPath
        ? {
            ok: false,
            problem: "worktree-owner-mismatch",
            detail: "the retained root belongs outside the claimed repo",
          }
        : { ok: true }
    );
    (app as unknown as { bindingCheck: unknown }).bindingCheck = bindingCheck;
    const createSpy = vi.spyOn(SessionActor, "create");
    const approvalKeySpy = vi.spyOn(
      app as unknown as { approvalKeyFor(path: string): Promise<string> },
      "approvalKeyFor"
    );
    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

      expect(out).toMatch(/無法通過驗證/);
      expect(bindingCheck).toHaveBeenCalledWith(
        expect.objectContaining({ workDir: validationPath }),
        expect.anything()
      );
      expect(validationPath).not.toBe(restoredWorktreePath);
      expect(sessions(app).get("t1")?.actor).toBe(actor as unknown as Session["actor"]);
      expect(createSpy).not.toHaveBeenCalled();
      expect(approvalKeySpy).not.toHaveBeenCalled();
      expect(rootClose).toHaveBeenCalledTimes(1);
      expect(transport.notices).toEqual([]);
    } finally {
      createSpy.mockRestore();
      approvalKeySpy.mockRestore();
    }
  });

  it("derives a rebind approval key from the successfully validated descriptor path", async () => {
    const { app } = harness();
    const pathMode = process.platform === "win32" ? "win32" : "posix";
    const validationPath = process.platform === "win32" ? String.raw`C:\descriptor\98` : "/proc/self/fd/98";
    const rootClose = vi.fn(async () => undefined);
    const backend: SecureOpenBackend = {
      open: vi.fn(async () => {
        throw new Error("this regression only captures a root");
      }),
      openDirectory: vi.fn(async () => ({
        finalPath: repoB,
        validationPath,
        identity: "validated-target-root",
        directory: true,
        revalidate: async () => ({
          finalPath: repoB,
          identity: "validated-target-root",
          directory: true,
        }),
        close: rootClose,
      })),
    };
    (
      app as unknown as {
        actorCreateDependencies?: {
          secureOpen?: { backend?: SecureOpenBackend; pathMode?: "win32" | "posix" };
          fileDeliveryPlatform?: NodeJS.Platform;
        };
      }
    ).actorCreateDependencies = { secureOpen: { backend, pathMode }, fileDeliveryPlatform: "win32" };
    const bindingCheck = vi.fn(async (binding: { workDir: string }) => {
      expect(binding.workDir).toBe(validationPath);
      return { ok: true } as const;
    });
    (app as unknown as { bindingCheck: unknown }).bindingCheck = bindingCheck;
    const approvalKeySpy = vi
      .spyOn(app as unknown as { approvalKeyFor(path: string): Promise<string> }, "approvalKeyFor")
      .mockResolvedValue(repoB);

    try {
      await expect(applyRebind(app, { repoPath: repoB, devMode: "local" })).resolves.toMatch(/已改綁/);
      expect(bindingCheck).toHaveBeenCalledOnce();
      expect(approvalKeySpy).toHaveBeenCalledExactlyOnceWith(validationPath);
    } finally {
      approvalKeySpy.mockRestore();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
    }
  });

  it("says the conversation is gone, and starts the new session with no history", async () => {
    const { app } = harness();
    const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });
    expect(out).toMatch(/全新的對話/);
    expect(sessions(app).get("t1")?.hasRunTurn).toBe(false);
    expect(sessions(app).get("t1")?.repoPath).toBe(repoB);
  });

  it("preserves and wires the durable file quota when rebinding the thread", async () => {
    const { app, store } = harness();
    expect(store.reserveFileDeliveryBytes("t1", "s1", 1, 0, 17)).toBe(true);
    const seen: SessionActorOpts[] = [];
    const originalCreate = SessionActor.create;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation((client, options) => {
      seen.push(options);
      return originalCreate(client, options);
    });
    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

      expect(out).toMatch(/已改綁/);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.initialFileDeliveryBytes).toBe(17);
      expect(
        seen[0]!.reserveFileDeliveryBytes(
          seen[0]!.fileDeliverySessionId,
          seen[0]!.generation ?? 1,
          18,
          17
        )
      ).toBe(true);
      expect(store.get("t1")?.fileDeliveryBytes).toBe(18);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("rejects an old actor quota reservation after the rebind record replaces its identity", async () => {
    const { app, store, actor } = harness();
    expect(store.reserveFileDeliveryBytes("t1", "s1", 1, 0, 17)).toBe(true);
    const originalCreate = SessionActor.create;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation((client, options) => {
      // This runs after applyRebind has durably installed its replacement row,
      // exactly where an old actor's delayed reservation used to overwrite it.
      actor.oldQuotaReserve = store.reserveFileDeliveryBytes("t1", "s1", 1, 17, 18);
      return originalCreate(client, options);
    });
    try {
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

      expect(out).toMatch(/已改綁/);
      expect(actor.suspendFileDeliveryCalls).toBe(1);
      expect(actor.oldQuotaReserve).toBe(false);
      expect(store.get("t1")?.fileDeliveryBytes).toBe(17);
      expect(new SessionStore(storeFile).get("t1")?.fileDeliveryBytes).toBe(17);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("preserves a secondary parent channel in the rebound durable record", async () => {
    const channels = testChannels();
    expect(channels.enable("c2", "u1")).toBe(true);
    const { app, store } = harness({ parentChannelId: "c2", channels });

    const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });

    expect(out).toMatch(/已改綁/);
    expect(store.get("t1")?.parentChannelId).toBe("c2");
  });

  it("warns loudly, and does NOT reclaim the old worktree, when teardown is unconfirmed", async () => {
    // Removing a tree an agent may still be writing to is the one ordering that
    // can destroy work.
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-test-${Date.now()}`, "t1");
    await addWorktree(repoA, oldWt, "copilot/t-t1");
    try {
      const { app } = harness({ devMode: "worktree" });
      const s = sessions(app).get("t1")!;
      s.workDir = oldWt;
      s.branch = "copilot/t-t1";
      (s.actor as unknown as FakeActor).disconnectFails = true;
      const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });
      expect(out).toMatch(/無法確認舊的 runtime/);
      expect(out).toMatch(/保留/);
      expect(fs.existsSync(oldWt)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
    }
  });

  it("persists and retries a post-swap old actor before releasing its root and worktree", async () => {
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-stale-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    let cleanupApp: DiscordCopilotApp | undefined;
    await addWorktree(repoA, oldWt, branch);
    try {
      const { app, store, actor } = harness({ devMode: "worktree" });
      cleanupApp = app;
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const s = sessions(app).get("t1")!;
      s.workDir = oldWt;
      s.branch = branch;
      actor.disconnectFails = true;

      await expect(applyRebind(app, { repoPath: repoB, devMode: "local" })).resolves.toMatch(
        /無法確認舊的 runtime/
      );

      expect(staleRebindActors(app).has(actor as unknown as SessionActor)).toBe(true);
      expect(staleRebinds(store)).toEqual([
        expect.objectContaining({
          threadId: "t1",
          sessionId: "s1",
          generation: 1,
          workDir: oldWt,
          branch,
          state: "blocked",
          reason: "rebind-teardown-unconfirmed",
        }),
      ]);
      expect(staleRebinds(new SessionStore(storeFile))).toEqual([
        expect.objectContaining({ sessionId: "s1", workDir: oldWt, reason: "rebind-teardown-unconfirmed" }),
      ]);

      actor.disconnectFails = false;
      await retryStaleRebinds(app);

      expect(staleRebindActors(app).has(actor as unknown as SessionActor)).toBe(false);
      expect(staleRebinds(store)).toEqual([]);
      expect(fs.existsSync(oldWt)).toBe(false);
    } finally {
      if (cleanupApp) await sessions(cleanupApp).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
    }
  });

  it("/end wins while target binding is still pending and removes the unowned worktree", async () => {
    const { app, store, actor } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    let bindingStarted!: () => void;
    const bindingStartedPromise = new Promise<void>((resolve) => {
      bindingStarted = resolve;
    });
    (app as unknown as { bindingCheck: unknown }).bindingCheck = async () => {
      bindingStarted();
      await bindingGate;
      return { ok: true };
    };
    const createSpy = vi.spyOn(SessionActor, "create");

    try {
      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await bindingStartedPromise;

      await endThread(app);
      releaseBinding();
      await expect(rebinding).resolves.toMatch(/已結束/);

      expect(createSpy).not.toHaveBeenCalled();
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(actor.disconnectCalls).toBe(1);
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      createSpy.mockRestore();
      releaseBinding?.();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end cleans a replacement actor and record created after its rebind reservation", async () => {
    const { app, store } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    const originalCreate = SessionActor.create;
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let replacementCreated!: () => void;
    const replacementCreatedPromise = new Promise<void>((resolve) => {
      replacementCreated = resolve;
    });
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementDisconnect = vi.spyOn(replacement, "disconnect");
      replacementDisconnect.mockRejectedValueOnce(new Error("first teardown attempt unconfirmed"));
      replacementCreated();
      await createGate;
      return replacement;
    });

    try {
      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await replacementCreatedPromise;
      expect(store.get("t1")?.state).toBe("creating");

      await endThread(app);
      releaseCreate();
      await expect(rebinding).resolves.toMatch(/已結束/);

      await vi.waitFor(() => expect(replacementDisconnect).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          (app as unknown as { staleRebindActors: Map<SessionActor, unknown> }).staleRebindActors.size
        ).toBe(0)
      );
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(leases(app).get(leaseKeyOf(repoA))).toBeUndefined();
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      createSpy.mockRestore();
      releaseCreate?.();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end removes a fallback reservation after confirmed replacement teardown without resurrecting the ended session", async () => {
    const { app, store } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    const originalCreate = SessionActor.create;
    const originalRetain = store.retainStaleRebind.bind(store);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let replacementCreated!: () => void;
    const replacementCreatedPromise = new Promise<void>((resolve) => {
      replacementCreated = resolve;
    });
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementDisconnect = vi
        .spyOn(replacement, "disconnect")
        .mockRejectedValue(new Error("replacement runtime remains live"));
      replacementCreated();
      await createGate;
      return replacement;
    });
    const retainSpy = vi.spyOn(store, "retainStaleRebind").mockImplementation((binding, reason) => {
      if (reason === "rebind-teardown-unconfirmed" && binding.sessionId !== "s1") return false;
      return originalRetain(binding, reason);
    });

    try {
      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await replacementCreatedPromise;
      await endThread(app);
      releaseCreate();

      await expect(rebinding).resolves.toMatch(/安全屏障/);
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toMatchObject({ repoPath: repoB, state: "creating" });
      expect(new SessionStore(storeFile).get("t1")).toMatchObject({ repoPath: repoB, state: "creating" });
      expect(staleRebindActors(app).size).toBe(1);
      expect(fs.existsSync(targetWorktree)).toBe(true);

      replacementDisconnect!.mockResolvedValue(undefined);
      await retryStaleRebinds(app);

      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(new SessionStore(storeFile).get("t1")).toBeUndefined();
      expect(staleRebinds(store)).toEqual([]);
      expect(staleRebindActors(app).size).toBe(0);
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      retainSpy.mockRestore();
      replacementDisconnect?.mockResolvedValue(undefined);
      await retryStaleRebinds(app);
      createSpy.mockRestore();
      releaseCreate?.();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end changes a commit-failure fallback to removal before its later replacement retry", async () => {
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-late-end-fallback-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    await addWorktree(repoA, oldWt, branch);
    const originalCreate = SessionActor.create;
    let cleanupApp: DiscordCopilotApp | undefined;
    let releaseInitialDisconnect!: () => void;
    const initialDisconnectGate = new Promise<void>((resolve) => {
      releaseInitialDisconnect = resolve;
    });
    let initialDisconnectStarted!: () => void;
    const initialDisconnectStartedPromise = new Promise<void>((resolve) => {
      initialDisconnectStarted = resolve;
    });
    let releaseReplacementDisconnect!: () => void;
    const replacementDisconnectGate = new Promise<void>((resolve) => {
      releaseReplacementDisconnect = resolve;
    });
    let replacementDisconnectStarted!: () => void;
    const replacementDisconnectStartedPromise = new Promise<void>((resolve) => {
      replacementDisconnectStarted = resolve;
    });
    let releaseRetryDisconnect!: () => void;
    const retryDisconnectGate = new Promise<void>((resolve) => {
      releaseRetryDisconnect = resolve;
    });
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    let rebinding: Promise<string> | undefined;
    let retainSpy: { mockRestore(): void } | undefined;
    let commitSpy: { mockRestore(): void } | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      let calls = 0;
      replacementDisconnect = vi.spyOn(replacement, "disconnect").mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          initialDisconnectStarted();
          await initialDisconnectGate;
          throw new Error("initial commit-failure teardown did not confirm");
        }
        if (calls === 2) {
          replacementDisconnectStarted();
          await replacementDisconnectGate;
          throw new Error("replacement retry still did not confirm");
        }
        await retryDisconnectGate;
      });
      return replacement;
    });

    try {
      const { app, store } = harness({ devMode: "worktree" });
      cleanupApp = app;
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const old = sessions(app).get("t1")!;
      old.workDir = oldWt;
      old.branch = branch;
      const originalRetain = store.retainStaleRebind.bind(store);
      retainSpy = vi.spyOn(store, "retainStaleRebind").mockImplementation((binding, reason) => {
        if (reason === "rebind-teardown-unconfirmed" && binding.sessionId !== "s1") return false;
        return originalRetain(binding, reason);
      });
      commitSpy = vi.spyOn(store, "commit").mockReturnValue(false);

      rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await initialDisconnectStartedPromise;
      const target = store.get("t1")!;
      expect(staleRebindActors(app).size).toBe(0);

      await endThread(app);
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(fs.existsSync(oldWt)).toBe(false);
      expect(fs.existsSync(targetWorktree)).toBe(true);

      releaseInitialDisconnect();
      await replacementDisconnectStartedPromise;
      expect([...staleRebindActors(app).values()][0]).toMatchObject({
        fallbackPrimary: {
          action: "remove",
          expectedTarget: {
            threadId: "t1",
            sessionId: target.sessionId,
            generation: target.generation,
          },
        },
      });

      releaseReplacementDisconnect();
      await expect(rebinding).resolves.toMatch(/已結束/);
      expect(store.get("t1")).toMatchObject({
        sessionId: target.sessionId,
        generation: target.generation,
        state: "creating",
      });
      expect(staleRebindActors(app).size).toBe(1);
      expect(fs.existsSync(targetWorktree)).toBe(true);

      releaseRetryDisconnect();
      await retryStaleRebinds(app);

      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(new SessionStore(storeFile).get("t1")).toBeUndefined();
      expect(staleRebinds(store)).toEqual([]);
      expect(staleRebindActors(app).size).toBe(0);
      expect(fs.existsSync(oldWt)).toBe(false);
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      releaseInitialDisconnect?.();
      releaseReplacementDisconnect?.();
      releaseRetryDisconnect?.();
      await rebinding?.catch(() => {});
      retainSpy?.mockRestore();
      commitSpy?.mockRestore();
      replacementDisconnect?.mockRestore();
      createSpy.mockRestore();
      if (cleanupApp) {
        await retryStaleRebinds(cleanupApp);
        await sessions(cleanupApp).get("t1")?.actor.disconnect().catch(() => {});
      }
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end keeps the late fallback barrier and tracker when removal reconciliation cannot persist", async () => {
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-late-end-fallback-cas-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    await addWorktree(repoA, oldWt, branch);
    const originalCreate = SessionActor.create;
    let cleanupApp: DiscordCopilotApp | undefined;
    let releaseInitialDisconnect!: () => void;
    const initialDisconnectGate = new Promise<void>((resolve) => {
      releaseInitialDisconnect = resolve;
    });
    let initialDisconnectStarted!: () => void;
    const initialDisconnectStartedPromise = new Promise<void>((resolve) => {
      initialDisconnectStarted = resolve;
    });
    let releaseReplacementDisconnect!: () => void;
    const replacementDisconnectGate = new Promise<void>((resolve) => {
      releaseReplacementDisconnect = resolve;
    });
    let replacementDisconnectStarted!: () => void;
    const replacementDisconnectStartedPromise = new Promise<void>((resolve) => {
      replacementDisconnectStarted = resolve;
    });
    let releaseRetryDisconnect!: () => void;
    const retryDisconnectGate = new Promise<void>((resolve) => {
      releaseRetryDisconnect = resolve;
    });
    let replacementDisconnect: ReturnType<typeof vi.spyOn> | undefined;
    let retainSpy: { mockRestore(): void } | undefined;
    let reconcileSpy: { mockRestore(): void } | undefined;
    let commitSpy: { mockRestore(): void } | undefined;
    let rebinding: Promise<string> | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      let calls = 0;
      replacementDisconnect = vi.spyOn(replacement, "disconnect").mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          initialDisconnectStarted();
          await initialDisconnectGate;
          throw new Error("initial commit-failure teardown did not confirm");
        }
        if (calls === 2) {
          replacementDisconnectStarted();
          await replacementDisconnectGate;
          return;
        }
        await retryDisconnectGate;
      });
      return replacement;
    });

    try {
      const { app, store } = harness({ devMode: "worktree" });
      cleanupApp = app;
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const old = sessions(app).get("t1")!;
      old.workDir = oldWt;
      old.branch = branch;
      const originalRetain = store.retainStaleRebind.bind(store);
      retainSpy = vi.spyOn(store, "retainStaleRebind").mockImplementation((binding, reason) => {
        if (reason === "rebind-teardown-unconfirmed" && binding.sessionId !== "s1") return false;
        return originalRetain(binding, reason);
      });
      reconcileSpy = vi
        .spyOn(store, "reconcileFallbackPrimary")
        .mockReturnValue({ ok: false, quotaAdvanced: false });
      commitSpy = vi.spyOn(store, "commit").mockReturnValue(false);

      rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await initialDisconnectStartedPromise;
      const target = store.get("t1")!;

      await endThread(app);
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(fs.existsSync(oldWt)).toBe(false);

      releaseInitialDisconnect();
      await replacementDisconnectStartedPromise;
      releaseReplacementDisconnect();
      await expect(rebinding).resolves.toMatch(/已結束/);
      releaseRetryDisconnect();
      await retryStaleRebinds(app);

      expect(store.get("t1")).toMatchObject({
        sessionId: target.sessionId,
        generation: target.generation,
        state: "creating",
      });
      expect(new SessionStore(storeFile).get("t1")).toMatchObject({
        sessionId: target.sessionId,
        generation: target.generation,
        state: "creating",
      });
      expect(staleRebindActors(app).size).toBe(1);
      expect(fs.existsSync(oldWt)).toBe(false);
      expect(fs.existsSync(targetWorktree)).toBe(false);

      reconcileSpy.mockRestore();
      reconcileSpy = undefined;
      await retryStaleRebinds(app);
      expect(store.get("t1")).toBeUndefined();
      expect(staleRebindActors(app).size).toBe(0);
    } finally {
      releaseInitialDisconnect?.();
      releaseReplacementDisconnect?.();
      releaseRetryDisconnect?.();
      await rebinding?.catch(() => {});
      reconcileSpy?.mockRestore();
      retainSpy?.mockRestore();
      commitSpy?.mockRestore();
      replacementDisconnect?.mockRestore();
      createSpy.mockRestore();
      if (cleanupApp) {
        await retryStaleRebinds(cleanupApp);
        await sessions(cleanupApp).get("t1")?.actor.disconnect().catch(() => {});
      }
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end invalidates a rebind after its map swap so it cannot recreate the session", async () => {
    const { app, store, actor } = harness();
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    let releaseOldDisconnect!: () => void;
    const oldDisconnectGate = new Promise<void>((resolve) => {
      releaseOldDisconnect = resolve;
    });
    let oldDisconnectStarted!: () => void;
    const oldDisconnectStartedPromise = new Promise<void>((resolve) => {
      oldDisconnectStarted = resolve;
    });
    actor.disconnectGate = oldDisconnectGate;
    actor.onDisconnect = oldDisconnectStarted;

    try {
      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await oldDisconnectStartedPromise;
      expect(sessions(app).get("t1")?.actor).not.toBe(actor as unknown as Session["actor"]);

      await endThread(app);
      releaseOldDisconnect();
      await expect(rebinding).resolves.toMatch(/已結束/);

      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      releaseOldDisconnect?.();
      await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end after a map swap owns both the replacement and preflight-clean old worktrees", async () => {
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-end-both-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    await addWorktree(repoA, oldWt, branch);
    let releaseOldDisconnect!: () => void;
    const oldDisconnectGate = new Promise<void>((resolve) => {
      releaseOldDisconnect = resolve;
    });
    let oldDisconnectStarted!: () => void;
    const oldDisconnectStartedPromise = new Promise<void>((resolve) => {
      oldDisconnectStarted = resolve;
    });
    let releaseReplacementDisconnect!: () => void;
    const replacementDisconnectGate = new Promise<void>((resolve) => {
      releaseReplacementDisconnect = resolve;
    });
    let replacementDisconnectStarted!: () => void;
    const replacementDisconnectStartedPromise = new Promise<void>((resolve) => {
      replacementDisconnectStarted = resolve;
    });
    let cleanupApp: DiscordCopilotApp | undefined;

    try {
      const { app, store, actor } = harness({ devMode: "worktree" });
      cleanupApp = app;
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const old = sessions(app).get("t1")!;
      old.workDir = oldWt;
      old.branch = branch;
      actor.disconnectGate = oldDisconnectGate;
      actor.onDisconnect = oldDisconnectStarted;

      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await oldDisconnectStartedPromise;
      const replacement = sessions(app).get("t1")!.actor;
      const originalDisconnect = replacement.disconnect.bind(replacement);
      const replacementDisconnect = vi.spyOn(replacement, "disconnect").mockImplementation(async () => {
        replacementDisconnectStarted();
        await replacementDisconnectGate;
        return originalDisconnect();
      });

      const ending = endThread(app);
      await replacementDisconnectStartedPromise;
      releaseOldDisconnect();
      releaseReplacementDisconnect();
      await ending;
      await expect(rebinding).resolves.toMatch(/已結束/);

      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(staleRebinds(store)).toEqual([]);
      expect(fs.existsSync(targetWorktree)).toBe(false);
      expect(fs.existsSync(oldWt)).toBe(false);
      replacementDisconnect.mockRestore();
    } finally {
      releaseOldDisconnect?.();
      releaseReplacementDisconnect?.();
      if (cleanupApp) await sessions(cleanupApp).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("/end retains an unconfirmed old incarnation durably and cleans it on a later explicit retry", async () => {
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-end-stale-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    let cleanupApp: DiscordCopilotApp | undefined;
    await addWorktree(repoA, oldWt, branch);
    try {
      const { app, store, actor } = harness({ devMode: "worktree" });
      cleanupApp = app;
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const old = sessions(app).get("t1")!;
      old.workDir = oldWt;
      old.branch = branch;
      actor.disconnectFails = true;

      await expect(applyRebind(app, { repoPath: repoB, devMode: "worktree" })).resolves.toMatch(
        /無法確認舊的 runtime/
      );
      await endThread(app);

      expect(store.get("t1")).toBeUndefined();
      expect(staleRebinds(new SessionStore(storeFile))).toEqual([
        expect.objectContaining({
          threadId: "t1",
          sessionId: "s1",
          generation: 1,
          workDir: oldWt,
          branch,
          state: "blocked",
          reason: "rebind-teardown-unconfirmed",
        }),
      ]);
      expect(fs.existsSync(targetWorktree)).toBe(false);
      expect(fs.existsSync(oldWt)).toBe(true);

      actor.disconnectFails = false;
      await endThread(app);

      expect(staleRebinds(store)).toEqual([]);
      expect(fs.existsSync(oldWt)).toBe(false);
    } finally {
      if (cleanupApp) await sessions(cleanupApp).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("forgets a pre-swap stale retry tracker only after a later /end confirms teardown and cleanup", async () => {
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-pre-swap-retry-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    await addWorktree(repoA, oldWt, branch);
    const originalCreate = SessionActor.create;
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let replacementCreated!: () => void;
    const replacementCreatedPromise = new Promise<void>((resolve) => {
      replacementCreated = resolve;
    });
    let cleanupApp: DiscordCopilotApp | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementCreated();
      await createGate;
      return replacement;
    });

    try {
      const { app, store, actor } = harness({ devMode: "worktree" });
      cleanupApp = app;
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const old = sessions(app).get("t1")!;
      old.workDir = oldWt;
      old.branch = branch;
      actor.disconnectFails = true;

      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await replacementCreatedPromise;
      await endThread(app);
      expect(staleRebindActors(app).has(actor as unknown as SessionActor)).toBe(true);

      actor.disconnectFails = false;
      await endThread(app);

      expect(staleRebindActors(app).has(actor as unknown as SessionActor)).toBe(false);
      expect(fs.existsSync(oldWt)).toBe(false);
      releaseCreate();
      await expect(rebinding).resolves.toMatch(/已結束/);
      expect(sessions(app).get("t1")).toBeUndefined();
      expect(store.get("t1")).toBeUndefined();
      expect(fs.existsSync(targetWorktree)).toBe(false);
    } finally {
      createSpy.mockRestore();
      releaseCreate?.();
      if (cleanupApp) await sessions(cleanupApp).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("keeps a terminal old pointer when /end races a failed pre-swap rebind rollback", async () => {
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-rollback-end-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    const targetWorktree = worktreePath(worktreeRoot(), repoB, "t1");
    await addWorktree(repoA, oldWt, branch);
    const originalCreate = SessionActor.create;
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let replacementCreated!: () => void;
    const replacementCreatedPromise = new Promise<void>((resolve) => {
      replacementCreated = resolve;
    });
    let cleanupApp: DiscordCopilotApp | undefined;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation(async (client, options) => {
      const replacement = await originalCreate(client, options);
      replacementCreated();
      await createGate;
      return replacement;
    });

    try {
      const { app, store, actor } = harness({ devMode: "worktree" });
      cleanupApp = app;
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const old = sessions(app).get("t1")!;
      old.workDir = oldWt;
      old.branch = branch;
      actor.disconnectFails = true;

      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "worktree" });
      await replacementCreatedPromise;
      await endThread(app);
      releaseCreate();
      await expect(rebinding).resolves.toMatch(/已結束/);

      expect(store.get("t1")).toBeUndefined();
      expect(staleRebinds(new SessionStore(storeFile))).toEqual([
        expect.objectContaining({
          threadId: "t1",
          sessionId: "s1",
          generation: 1,
          workDir: oldWt,
          branch,
          state: "blocked",
          reason: "rebind-teardown-unconfirmed",
        }),
      ]);
      expect(fs.existsSync(targetWorktree)).toBe(false);
      expect(fs.existsSync(oldWt)).toBe(true);
    } finally {
      createSpy.mockRestore();
      releaseCreate?.();
      if (cleanupApp) await sessions(cleanupApp).get("t1")?.actor.disconnect().catch(() => {});
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
      fs.rmSync(path.dirname(targetWorktree), { recursive: true, force: true });
    }
  });

  it("does nothing when the thread no longer has a session", async () => {
    const { app } = harness();
    sessions(app).delete("t1");
    expect(await applyRebind(app, { repoPath: repoB, devMode: "local" })).toMatch(/沒有進行中的 session/);
  });
});


describe("applyRebind — the process lock", { timeout: 60_000 }, () => {
  it("holds the lock for an unconfirmed retired incarnation, and lets go once a real retry confirms it", async () => {
    // The end-to-end shape of the defect: a NORMAL, successful rebind retires
    // the old actor, its disconnect cannot be confirmed, and the process still
    // owns a runtime that may be holding the old checkout. Before the stale
    // incarnation became a coordinator obligation this route only added the
    // app's own index entry, so `stop()` released the single-instance lock and
    // a successor could start against a repo this process had not let go of.
    const { app, actor } = harness({ devMode: "local", repo: repoA });
    let releases = 0;
    useObservableLock(app, {
      path: "(observable)",
      release: async () => {
        releases++;
      },
    });
    // The old runtime does not answer. Its cleanup is therefore unprovable.
    actor.disconnectFails = true;

    const out = await applyRebind(app, { repoPath: repoB, devMode: "local" });
    expect(out).toMatch(/已改綁/);

    // The app kept the actor, and the coordinator was told about it.
    expect(staleRebindActors(app).size).toBe(1);
    assertEveryRetainedRuntimeIsOwed(app);
    const entry = [...staleRebindActors(app).values()][0] as {
      binding: { threadId: string; sessionId: string; generation: number };
    };
    const key = staleRebindKey(entry.binding);
    expect(inspectOwnership(app).obligationKeys()).toContain(key);

    // A full shutdown may NOT release the lock: the sweep re-attempts the
    // disconnect, it still fails, and the obligation stays.
    await app.stop();
    expect(releases).toBe(0);
    expect(inspectOwnership(app).obligationKeys()).toContain(key);
    assertEveryRetainedRuntimeIsOwed(app);

    // The runtime finally answers, through the REAL retry path — not by poking
    // the coordinator. Confirmation discharges the obligation by identity, the
    // coordinator re-draws its conclusion, and the lock goes exactly once.
    actor.disconnectFails = false;
    await retryStaleRebinds(app);
    expect(staleRebindActors(app).size).toBe(0);
    expect(inspectOwnership(app).obligationKeys()).not.toContain(key);
    assertEveryRetainedRuntimeIsOwed(app);
    await vi.waitFor(() => expect(releases).toBe(1));

    await sessions(app).get("t1")?.actor.disconnect().catch(() => {});
  });

  it("says nothing about a retained lock when the runtime confirmed and only the tree was kept", async () => {
    // The runtime stopping is what ends this incarnation's claim on the PROCESS
    // lock; a worktree kept because it was dirty is durably recorded and is the
    // operator's to reclaim. The app therefore discharges the obligation on
    // `confirmed` while its bounded attempt still reports `confirmed && cleaned`
    // — i.e. false. Reading that `false` as "still owed" made shutdown announce
    // a retention that had not happened, about an obligation already gone.
    const wtRoot = `${path.join(os.homedir(), ".discord-copilot-sdk")}-worktrees`;
    const oldWt = path.join(wtRoot, `rebind-dirty-${Date.now()}`, "t1");
    const branch = "copilot/t-t1";
    await addWorktree(repoA, oldWt, branch);
    try {
      const { app, store, actor } = harness({ devMode: "worktree" });
      const messages: string[] = [];
      let releases = 0;
      useObservableOwnership(
        app,
        {
          path: "(test)",
          release: async () => {
            releases++;
          },
        },
        (m) => messages.push(m)
      );
      const oldRecord = store.get("t1")!;
      expect(store.restore({ ...oldRecord, workDir: oldWt, branch, devMode: "worktree" })).toBe(true);
      const s = sessions(app).get("t1")!;
      s.workDir = oldWt;
      s.branch = branch;
      // The rebind cannot confirm the old runtime, so it is retained and owed.
      actor.disconnectFails = true;
      await expect(applyRebind(app, { repoPath: repoB, devMode: "local" })).resolves.toMatch(
        /無法確認舊的 runtime/
      );
      assertEveryRetainedRuntimeIsOwed(app);

      // …and by shutdown the runtime answers, but the tree has work in it.
      actor.disconnectFails = false;
      fs.writeFileSync(path.join(oldWt, "unsaved.txt"), "work in progress");

      await app.stop();

      expect(messages.filter((m) => /could not be discharged/.test(m))).toEqual([]);
      expect(fs.existsSync(oldWt)).toBe(true); // kept, exactly as promised
      expect(releases).toBe(1); // …and the process lock genuinely goes
    } finally {
      fs.rmSync(path.dirname(oldWt), { recursive: true, force: true });
    }
  });
});

describe("beginRebind answers through whichever door is still open", () => {
  /** `/repo` can reach `beginRebind` in three acknowledgement states, and each
   *  has exactly one legal method. Getting it wrong throws
   *  `InteractionAlreadyReplied`/`InteractionNotReplied` in production and used
   *  to be invisible in tests. The no-session branch answers immediately, so it
   *  exercises the door without any git work. */
  const noSession = (app: DiscordCopilotApp): void => {
    sessions(app).delete("t1");
  };

  it("replies when nothing has acknowledged yet", async () => {
    const { app } = harness();
    noSession(app);
    const interaction = strictInteraction();

    await beginRebind(app, interaction, { devMode: "worktree" });

    expect(interaction.replyCalls).toBe(1);
    expect(interaction.editCalls).toBe(0);
    expect(interaction.followUpCalls).toBe(0);
    expect(interaction.answers[0]).toMatch(/沒有進行中的 session/);
  });

  it("edits when the interaction was already deferred", async () => {
    const { app } = harness();
    noSession(app);
    const interaction = strictInteraction();
    await interaction.deferReply();

    await beginRebind(app, interaction, { devMode: "worktree" });

    expect(interaction.replyCalls).toBe(0);
    expect(interaction.editCalls).toBe(1);
    expect(interaction.followUpCalls).toBe(0);
  });

  it("follows up when /repo clone has already deferred AND edited", async () => {
    // This is the `alreadyReplied` path. The interaction is fully answered, so
    // `reply` and a second `editReply` would both be wrong: a follow-up is the
    // only way to add the rebind confirmation to the same interaction.
    const { app } = harness();
    noSession(app);
    const interaction = strictInteraction();
    await interaction.deferReply();
    await interaction.editReply({ content: "cloned" });

    await beginRebind(app, interaction, { devMode: "worktree" }, { alreadyReplied: true });

    expect(interaction.replyCalls).toBe(0);
    expect(interaction.editCalls).toBe(1); // just the clone's own answer
    expect(interaction.followUpCalls).toBe(1);
    expect(interaction.answers[1]).toMatch(/沒有進行中的 session/);
  });
});

describe("a shutdown mid-rebind keeps the OLD conversation resumable", { timeout: 60_000 }, () => {
  it("restores the displaced primary instead of leaving the thread with none", async () => {
    // The pre-swap state this exercises is the real one: the old record has been
    // moved aside as a stale companion and the thread slot now holds the target
    // `creating` reservation. Abandoning by REMOVING the target — which is right
    // for `/end`, because the operator gave the conversation up — left a
    // shutdown-interrupted thread with no resumable record at all: its only
    // durable trace was a terminal stale-rebind pointer, and the next boot could
    // not bring the conversation back. The operator never even completed the
    // rebind.
    const { app, store, actor } = harness({ devMode: "local", repo: repoA });
    const before = store.get("t1")!;
    expect(before.state).toBe("active");

    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let creating = false;
    const create = vi
      .spyOn(SessionActor, "create")
      .mockImplementation(async () => {
        creating = true;
        await held;
        return {
          disconnect: async () => {},
          isFaulted: () => false,
          generationOf: () => 1,
          stop: async () => true,
          suspendFileDelivery: () => 1,
          resumeFileDeliveryIfCurrent: () => true,
          canDeliverFiles: () => false,
        } as unknown as SessionActor;
      });

    try {
      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "local" });
      await vi.waitFor(() => expect(creating).toBe(true));

      // Mid-create the store really is in the pre-swap shape.
      expect(store.get("t1")).toMatchObject({ repoPath: repoB, state: "creating" });
      expect(staleRebinds(store)).toHaveLength(1);

      // A SIGTERM, NOT an explicit /end.
      const stopping = app.stop().catch(() => {});
      await Promise.resolve();
      release();
      await rebinding;
      await stopping;

      // Reloaded from disk: the old conversation is back, active and resumable,
      // the target reservation is gone, and the stale companion was reconciled.
      const reloaded = new SessionStore(storeFile);
      expect(reloaded.get("t1")).toMatchObject({
        sessionId: before.sessionId,
        repoPath: repoA,
        state: "active",
      });
      expect(staleRebinds(reloaded)).toEqual([]);
    } finally {
      create.mockRestore();
      void actor;
    }
  });

  it("still REMOVES the target when an explicit /end gave the conversation up", async () => {
    // The other half of the same decision, unchanged: `/end` is the winner.
    const { app, store } = harness({ devMode: "local", repo: repoA });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let creating = false;
    const create = vi.spyOn(SessionActor, "create").mockImplementation(async () => {
      creating = true;
      await held;
      return {
        disconnect: async () => {},
        isFaulted: () => false,
        generationOf: () => 1,
        stop: async () => true,
        suspendFileDelivery: () => 1,
        resumeFileDeliveryIfCurrent: () => true,
        canDeliverFiles: () => false,
      } as unknown as SessionActor;
    });

    try {
      const rebinding = applyRebind(app, { repoPath: repoB, devMode: "local" });
      await vi.waitFor(() => expect(creating).toBe(true));

      await endThread(app); // the operator ends the thread mid-rebind
      release();
      await rebinding;

      const reloaded = new SessionStore(storeFile);
      expect(reloaded.get("t1")).toBeUndefined(); // given up on purpose
    } finally {
      create.mockRestore();
    }
  });
});
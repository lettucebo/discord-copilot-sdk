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
import { SessionActor, type SessionActorOpts } from "../src/copilot/session-actor.js";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import type { DevMode } from "../src/core/binding.js";
import type { SecureOpenBackend } from "../src/core/secure-open.js";

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
  oldQuotaReserve?: boolean;
  isFaulted(): boolean {
    return false;
  }
  generationOf(): number {
    return 1;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls++;
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
    PERMISSION_POLICY: "ask",
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
    async stop() {},
  } as unknown as CopilotClient;
}

async function createActiveActor(workDir: string, transport: Transport): Promise<SessionActor> {
  return SessionActor.createForTest(fakeCopilot(), {
    sessionKey: "t1",
    workingDirectory: workDir,
    skillsHomeDirectory: path.join(tmp, "no-user-skills"),
    broker: new PendingInteractionBroker(),
    transport,
    policy: new ApprovalPolicy(path.join(tmp, `approvals-${Math.random()}.json`)),
    auditLog: { append: () => true },
    initialFileDeliveryBytes: 0,
    fileDeliverySessionId: "s1",
    reserveFileDeliveryBytes: () => true,
  });
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
    store,
    over.channels ?? testChannels()
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
      store,
      testChannels()
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
        };
      }
    ).actorCreateDependencies = { secureOpen: { backend, pathMode: "posix" } };
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
      expect(rootClose).toHaveBeenCalledTimes(1);
      expect(transport.notices).toEqual([]);
    } finally {
      createSpy.mockRestore();
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

  it("does nothing when the thread no longer has a session", async () => {
    const { app } = harness();
    sessions(app).delete("t1");
    expect(await applyRebind(app, { repoPath: repoB, devMode: "local" })).toMatch(/沒有進行中的 session/);
  });
});

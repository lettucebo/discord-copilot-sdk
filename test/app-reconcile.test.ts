import { describe, it, expect, vi, afterEach } from "vitest";
import { DiscordCopilotApp } from "../src/app.js";

/** Counts every real worktree recreation, and lets one test suspend INSIDE it.
 *  `resumeRecord` rebuilds a MISSING worktree from its surviving branch, which
 *  is a disk side effect that must not happen for a record `/end` or shutdown
 *  already claimed — and "it did not happen" is only assertable by watching the
 *  call, since a fixture repo makes the git command fail either way. With no
 *  hook installed both delegate to the real implementation, so no other test in
 *  this file changes behaviour. */
const { addWorktreeCalls, worktreeHooks, removeWorktreeCalls } = vi.hoisted(() => ({
  addWorktreeCalls: [] as Array<{ repo: string; dir: string; branch: string }>,
  removeWorktreeCalls: [] as Array<{ repo: string; dir: string; branch?: string }>,
  worktreeHooks: {} as {
    add?: (repo: string, dir: string, branch: string) => Promise<void>;
    remove?: (repo: string, dir: string, branch?: string) => Promise<string>;
  },
}));
vi.mock("../src/core/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/worktree.js")>();
  return {
    ...actual,
    addWorktree: async (repo: string, dir: string, branch: string): Promise<void> => {
      addWorktreeCalls.push({ repo, dir, branch });
      if (worktreeHooks.add) return worktreeHooks.add(repo, dir, branch);
      return actual.addWorktree(repo, dir, branch);
    },
    removeWorktreeIfClean: async (repo: string, dir: string, branch?: string): Promise<unknown> => {
      removeWorktreeCalls.push({ repo, dir, branch });
      if (worktreeHooks.remove) return worktreeHooks.remove(repo, dir, branch);
      return actual.removeWorktreeIfClean(repo, dir, branch);
    },
  };
});
import { SessionActor, type SessionActorOpts } from "../src/copilot/session-actor.js";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import type { SecureOpenBackend } from "../src/core/secure-open.js";
import type { InstanceLock } from "../src/core/single-instance.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import { tmpdir } from "node:os";
import { stateDir } from "../src/core/paths.js";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

const isolatedHome = (() => {
  const value = process.env["DISCORD_COPILOT_SDK_VITEST_HOME"];
  if (!value) throw new Error("Vitest home isolation is required");
  return value;
})();

const REPOS_ROOT = join(tmpdir(), "dcs-fixture-repos");
const REPO = join(REPOS_ROOT, "repo");
/** Where `bindingOk` requires a worktree-mode workDir to live. */
const WT_ROOT = `${stateDir()}-worktrees`;
const tmpFile = (): string => join(tmpdir(), `dp-reconcile-${Math.random()}.json`);

const bind = (over: Partial<SessionBinding> = {}): SessionBinding => {
  const merged = {
    threadId: "t1",
    sessionId: "sess-1",
    generation: 1,
    repoPath: REPO,
    guildId: "g1",
    parentChannelId: "c1",
    workDir: REPO,
    ...over,
  };
  // Infer the mode from the branch the same way the store's v2→v3 migration
  // does, so a fixture that sets `branch` reads as the worktree session it is.
  return { ...merged, devMode: over.devMode ?? (merged.branch ? "worktree" : "local") };
};

/** A worktree-mode record — what every session created by `/new` actually is.
 *  The directory is created for real: `resumeRecord` rebuilds a MISSING worktree
 *  from its branch, which needs a genuine repo, and that is not what these
 *  fixtures are testing. */
const wtDirs: string[] = [];
const wtBind = (id: string, over: Partial<SessionBinding> = {}): SessionBinding => {
  const workDir = join(WT_ROOT, "repo-hash", id);
  mkdirSync(workDir, { recursive: true });
  wtDirs.push(workDir);
  return bind({
    threadId: id,
    sessionId: `s-${id}`,
    workDir,
    branch: `copilot/t-${id}`,
    ...over,
  });
};

afterEach(() => {
  delete worktreeHooks.add;
  delete worktreeHooks.remove;
  for (const d of wtDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cfg = {
  DISCORD_BOT_TOKEN: "t",
  DISCORD_ALLOWED_USER_IDS: ["u1"],
  DISCORD_GUILD_ID: "g1",
  DISCORD_PARENT_CHANNEL_ID: "c1",
  REPOS_ROOT: REPOS_ROOT,
  DEFAULT_MODEL: "claude-sonnet-5",
  DEFAULT_CONTEXT_TIER: "default",
  ENABLE_REPO_SKILLS: "false",
  ENABLE_USER_SKILLS: "false",
} as unknown as Parameters<typeof DiscordCopilotApp.createForTest>[0];

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
  async noticeDelivered(_k: string, t: string): Promise<boolean> {
    this.notices.push(t);
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

const fakeSession = {
  sessionId: "sess-1",
  on(): void {},
  async disconnect(): Promise<void> {},
  async abort(): Promise<boolean> {
    return true;
  },
  rpc: { plan: { readSqlTodosWithDependencies: async () => ({ rows: [], dependencies: [] }) } },
};

/** Captures the config each resume was called with, so a test can assert the
 *  session came back into the RIGHT working directory. */
const resumeCalls: Array<{ id: string; cfg: Record<string, unknown> }> = [];

function fakeCopilot(
  opts: { resumeError?: string | ((id: string) => string | undefined) } = {}
): CopilotClient {
  return {
    createSession: async () => fakeSession,
    // A no-op `stop`, so a test may drive the real `app.stop()` teardown.
    async stop(): Promise<void> {},
    resumeSession: async (id: string, cfg: Record<string, unknown>) => {
      resumeCalls.push({ id, cfg });
      const e = typeof opts.resumeError === "function" ? opts.resumeError(id) : opts.resumeError;
      if (e) throw new Error(e);
      return fakeSession;
    },
  } as unknown as CopilotClient;
}

/** `start()` uses this same constructor without createForTest's test-only
 * dependency injection. Keep this harness narrow: it proves the production
 * construction path cannot silently acquire the fake trusted-root backend. */
function productionStyleApp(
  copilot: CopilotClient,
  transport: Transport,
  store: SessionStore
): DiscordCopilotApp {
  const AppConstructor = DiscordCopilotApp as unknown as {
    new (
      config: Parameters<typeof DiscordCopilotApp.createForTest>[0],
      client: CopilotClient,
      lock: { path: string; release(): Promise<void> },
      transportOverride: Transport,
      storeOverride: SessionStore,
      channelsOverride: ChannelRegistry
    ): DiscordCopilotApp;
  };
  const app = new AppConstructor(
    cfg,
    copilot,
    { path: "(production-style-test)", release: async () => {} },
    transport,
    store,
    new ChannelRegistry("c1", "g1", join(isolatedHome, "production-style-channels.json"))
  );
  (app as unknown as { reposRoot: string }).reposRoot = REPOS_ROOT;
  return app;
}

function sessionsOf(app: DiscordCopilotApp): Map<string, unknown> {
  return (app as unknown as { sessions: Map<string, unknown> }).sessions;
}
function localLeasesOf(app: DiscordCopilotApp): Map<string, string> {
  return (app as unknown as { localLeases: Map<string, string> }).localLeases;
}
/** The coordinator's read-only view of the sets the release conclusion is drawn
 *  from. A retry-discarded runtime that could not be confirmed stopped is an
 *  OBLIGATION here now, keyed `runtime:<threadId>`; the obligation object holds
 *  the actor, which is what keeps the Windows root alive. */
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
function hasRuntimeBarrier(app: DiscordCopilotApp, threadId: string): boolean {
  return inspectOwnership(app).obligationKeys().includes(`runtime:${threadId}`);
}
function obligationHandle(app: DiscordCopilotApp, threadId: string): unknown {
  return inspectOwnership(app).obligation(`runtime:${threadId}`);
}
/** Bounds the coordinator applies, as a test seam. Rebuilds it, so call before
 *  the app has anything in flight. */
function useOwnershipBounds(
  app: DiscordCopilotApp,
  options: { joinTimeoutMs?: number; obligationTimeoutMs?: number; teardownTimeoutMs?: number }
): void {
  (
    app as unknown as { useOwnershipForTest(l?: InstanceLock, o?: Record<string, unknown>): void }
  ).useOwnershipForTest(undefined, options);
}
/** Give the app a lock the test can watch. The lock now lives inside the
 *  lifecycle coordinator — the only thing allowed to release it — so a test
 *  observes releases by handing that coordinator an observable lock rather than
 *  by reaching for a field on the app. */
function useObservableLock(app: DiscordCopilotApp, lock: InstanceLock): void {
  (app as unknown as { useOwnershipForTest(l: InstanceLock): void }).useOwnershipForTest(lock);
}
function reconcile(
  app: DiscordCopilotApp,
  classify: (threadId: string, expectedParentChannelId: string) => Promise<string>,
  validateBinding: () => Promise<
    { ok: true } | { ok: false; problem: "repo-not-git"; detail: string }
  > = async () => ({ ok: true })
): Promise<void> {
  return (app as unknown as {
    reconcileOnStartup(d?: {
      classifyThread?: (id: string, expectedParentChannelId: string) => Promise<string>;
      validateBinding?: () => Promise<unknown>;
    }): Promise<void>;
  }).reconcileOnStartup({
    classifyThread: classify,
    // These fixtures use paths that do not exist on disk: they exercise the
    // reconcile STATE MACHINE, not the git-backed ownership proof (which has its
    // own suite in binding.test.ts, against real worktrees). Injecting a
    // pass-through keeps the two concerns from smearing into each other.
    validateBinding,
  });
}

function classifyThread(
  app: DiscordCopilotApp,
  threadId: string,
  expectedParentChannelId: string
): Promise<string> {
  return (
    app as unknown as {
      classifyThread(id: string, parentChannelId: string): Promise<string>;
    }
  ).classifyThread(threadId, expectedParentChannelId);
}

describe("reconcileOnStartup (app-level wiring, P2)", () => {
  it("createForTest resumes a nonexistent workdir with a root that refuses candidate opens", async () => {
    const f = tmpFile();
    const missingWorkDir = join(REPOS_ROOT, `nonexistent-workdir-${Math.random().toString(36).slice(2)}`);
    try {
      expect(existsSync(missingWorkDir)).toBe(false);
      const store = new SessionStore(f);
      store.reserve(bind({ repoPath: missingWorkDir, workDir: missingWorkDir }));
      store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);

      await reconcile(app, async () => "valid");

      const resumed = sessionsOf(app).get("t1") as
        | { actor: Pick<SessionActor, "resolveFileForDelivery"> }
        | undefined;
      expect(resumed).toBeDefined();
      await expect(resumed!.actor.resolveFileForDelivery("artifact.txt", "operator")).resolves.toEqual({
        ok: false,
        reason: "unreadable",
      });
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("derives a resumed session approval key from the successfully validated descriptor path", async () => {
    const f = tmpFile();
    const pathMode = process.platform === "win32" ? "win32" : "posix";
    const validationPath = process.platform === "win32" ? String.raw`C:\descriptor\resume` : "/proc/self/fd/resume";
    const rootClose = vi.fn(async () => undefined);
    const backend: SecureOpenBackend = {
      open: vi.fn(async () => {
        throw new Error("this regression only captures a root");
      }),
      openDirectory: vi.fn(async () => ({
        finalPath: REPO,
        validationPath,
        identity: "resume-validated-root",
        directory: true,
        revalidate: async () => ({
          finalPath: REPO,
          identity: "resume-validated-root",
          directory: true,
        }),
        close: rootClose,
      })),
    };
    try {
      const store = new SessionStore(f);
      store.reserve(bind());
      store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      const internals = app as unknown as {
        actorCreateDependencies?: {
          secureOpen?: { backend?: SecureOpenBackend; pathMode?: "win32" | "posix" };
          fileDeliveryPlatform?: NodeJS.Platform;
        };
        bindingCheck: (binding: { workDir: string }) => Promise<{ ok: true }>;
        approvalKeyFor(path: string): Promise<string>;
        resumeRecord(record: unknown): Promise<void>;
      };
      internals.actorCreateDependencies = { secureOpen: { backend, pathMode }, fileDeliveryPlatform: "win32" };
      internals.bindingCheck = vi.fn(async (binding) => {
        expect(binding.workDir).toBe(validationPath);
        return { ok: true } as const;
      });
      const approvalKeySpy = vi.spyOn(internals, "approvalKeyFor").mockResolvedValue(REPO);

      try {
        await internals.resumeRecord(store.get("t1"));
        expect(internals.bindingCheck).toHaveBeenCalledOnce();
        expect(approvalKeySpy).toHaveBeenCalledExactlyOnceWith(validationPath);
      } finally {
        approvalKeySpy.mockRestore();
        const actor = (sessionsOf(app).get("t1") as { actor?: { disconnect(): Promise<void> } } | undefined)?.actor;
        await actor?.disconnect().catch(() => {});
      }
      expect(rootClose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("production-style construction does not inject the test-only trusted root", async () => {
    const f = tmpFile();
    const missingWorkDir = join(REPOS_ROOT, `production-workdir-${Math.random().toString(36).slice(2)}`);
    try {
      expect(existsSync(missingWorkDir)).toBe(false);
      const store = new SessionStore(f);
      store.reserve(bind({ repoPath: missingWorkDir, workDir: missingWorkDir }));
      store.commit("t1");
      const app = productionStyleApp(fakeCopilot(), new FakeTransport(), store);

      await reconcile(app, async () => "valid");

      expect(sessionsOf(app).has("t1")).toBe(false);
      expect(store.get("t1")?.state).toBe("active");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("active + valid thread → resumes under its recorded parent, registers, keeps active, posts recovery notice", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      let classifiedParent: string | undefined;
      await reconcile(app, async (_threadId, expectedParentChannelId) => {
        classifiedParent = expectedParentChannelId;
        return "valid";
      });
      expect(sessionsOf(app).has("t1")).toBe(true);
      expect(store.get("t1")?.state).toBe("active");
      expect(classifiedParent).toBe("c1");
      expect(transport.notices.some((n) => n.includes("復原"))).toBe(true);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("passes a resumed record's durable file quota and store callback to its actor", async () => {
    const f = tmpFile();
    const seen: SessionActorOpts[] = [];
    const originalCreate = SessionActor.create;
    const createSpy = vi.spyOn(SessionActor, "create").mockImplementation((client, options) => {
      seen.push(options);
      return originalCreate(client, options);
    });
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ fileDeliveryBytes: 17 }));
      store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);

      await reconcile(app, async () => "valid");

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
      rmSync(f, { force: true });
    }
  });

  it("active + resume throws session-not-found → orphaned, not registered", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot({ resumeError: "session not found" }), transport, store);
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).has("t1")).toBe(false);
      expect(store.get("t1")?.state).toBe("orphaned");
      expect(store.get("t1")?.reason).toBe("session-lost");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("fails startup and retains the local lease when a binding block cannot persist", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        undefined,
        { fileDeliveryPlatform: "linux" }
      );
      const persist = vi.spyOn(store, "setState").mockReturnValue(false);

      try {
        await expect(
          reconcile(
            app,
            async () => "valid",
            async () => ({ ok: false, problem: "repo-not-git", detail: "git proof failed" })
          )
        ).rejects.toThrow(/could not persist blocked state/i);

        expect(store.get("t1")?.state).toBe("active");
        expect([...localLeasesOf(app).values()]).toEqual(["t1"]);
      } finally {
        persist.mockRestore();
      }
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("fails startup and retains the local lease when a definitive lost-session transition cannot persist", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot({ resumeError: "session not found" }),
        new FakeTransport(),
        store,
        undefined,
        { fileDeliveryPlatform: "linux" }
      );
      const persist = vi.spyOn(store, "setState").mockReturnValue(false);

      try {
        await expect(reconcile(app, async () => "valid")).rejects.toThrow(/could not persist orphaned state/i);

        expect(store.get("t1")?.state).toBe("active");
        expect([...localLeasesOf(app).values()]).toEqual(["t1"]);
      } finally {
        persist.mockRestore();
      }
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("active + resume throws TRANSIENT (network) → record LEFT ACTIVE for retry, not registered", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot({ resumeError: "getaddrinfo ENOTFOUND api.githubcopilot.com" }),
        transport,
        store
      );
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).has("t1")).toBe(false); // not resumed this boot
      expect(store.get("t1")?.state).toBe("active"); // preserved so a restart retries
      expect(transport.notices.some((n) => n.includes("暫時無法復原"))).toBe(true);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("active + thread gone → blocked:thread-gone, never resumes", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      let resumeTried = false;
      const client = {
        resumeSession: async () => {
          resumeTried = true;
          return fakeSession;
        },
      } as unknown as CopilotClient;
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, client, new FakeTransport(), store);
      await reconcile(app, async () => "gone");
      expect(store.get("t1")?.state).toBe("blocked");
      expect(store.get("t1")?.reason).toBe("thread-gone");
      expect(sessionsOf(app).has("t1")).toBe(false);
      expect(resumeTried).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("active + repo binding mismatch → blocked:config-mismatch WITHOUT fetching the thread", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ repoPath: join(tmpdir(), "dcs-fixture-OTHER-root", "repo") })); store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      let classifyCalls = 0;
      await reconcile(app, async () => {
        classifyCalls++;
        return "valid";
      });
      expect(store.get("t1")?.state).toBe("blocked");
      expect(store.get("t1")?.reason).toBe("config-mismatch");
      expect(classifyCalls).toBe(0); // never even fetched the thread
      expect(sessionsOf(app).has("t1")).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("active + disabled recorded parent → blocked:config-mismatch WITHOUT fetching the thread", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ parentChannelId: "c2" })); store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      let classifyCalls = 0;
      await reconcile(app, async () => {
        classifyCalls++;
        return "valid";
      });
      expect(store.get("t1")?.state).toBe("blocked");
      expect(store.get("t1")?.reason).toBe("config-mismatch");
      expect(classifyCalls).toBe(0);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("transient thread failure → record left unchanged (active), not resumed", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "transient");
      expect(store.get("t1")?.state).toBe("active"); // preserved for a later retry
      expect(sessionsOf(app).has("t1")).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("creating (interrupted create) → orphaned, not resumed", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); // creating
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      expect(store.get("t1")?.state).toBe("orphaned");
      expect(sessionsOf(app).has("t1")).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("does not resume a fallback creating reservation or resurrect its old session", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      expect(store.reserve(bind({ sessionId: "old", generation: 1 }))).toBe(true);
      expect(store.commit("t1")).toBe(true);
      const original = store.get("t1")!;
      expect(store.retainStaleRebind(original, "rebind-cleanup-pending")).toBe(true);
      // This is the primary barrier left when the replacement's own terminal
      // stale row could not persist. It is not a resumable conversation.
      expect(store.reserve(bind({ sessionId: "fallback-target", generation: 2 }))).toBe(true);

      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");

      expect(store.get("t1")).toMatchObject({
        sessionId: "fallback-target",
        generation: 2,
        state: "orphaned",
      });
      expect(sessionsOf(app).has("t1")).toBe(false);
      expect(store.staleRebinds()).toEqual([
        expect.objectContaining({ sessionId: "old", generation: 1, state: "blocked" }),
      ]);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("no record → fresh, nothing registered", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).size).toBe(0);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("resumes a record under an enabled secondary parent", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ parentChannelId: "c2" })); store.commit("t1");
      const channels = new ChannelRegistry("c1", "g1", registryFile);
      expect(channels.enable("c2", "u1")).toBe(true);
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        channels
      );
      let classifiedParent: string | undefined;
      await reconcile(app, async (_threadId, expectedParentChannelId) => {
        classifiedParent = expectedParentChannelId;
        return "valid";
      });
      expect(classifiedParent).toBe("c2");
      expect(sessionsOf(app).has("t1")).toBe(true);
      expect(store.get("t1")?.state).toBe("active");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("refuses corrupt channel registry before reconciliation can mutate an active record", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      writeFileSync(registryFile, "{ not valid json", "utf8");
      const channels = new ChannelRegistry("c1", "g1", registryFile);
      expect(channels.isCorrupt()).toBe(true);
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        channels
      );
      let classifyCalls = 0;
      await expect(
        reconcile(app, async () => {
          classifyCalls++;
          return "valid";
        })
      ).rejects.toThrow(/channel registry/i);
      expect(classifyCalls).toBe(0);
      expect(store.get("t1")?.state).toBe("active");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("classifies only a thread under the expected parent while that parent remains enabled", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const channels = new ChannelRegistry("c1", "g1", registryFile);
      expect(channels.enable("c2", "u1")).toBe(true);
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        new SessionStore(f),
        channels
      );
      (app as unknown as {
        discord: { channels: { fetch(id: string): Promise<unknown> } };
      }).discord = {
        channels: {
          async fetch() {
            return {
              isThread: () => true,
              guildId: "g1",
              parentId: "c2",
            };
          },
        },
      };

      await expect(classifyThread(app, "t1", "c2")).resolves.toBe("valid");
      await expect(classifyThread(app, "t1", "c1")).resolves.toBe("inaccessible");
      expect(channels.disable("c2")).toBe(true);
      await expect(classifyThread(app, "t1", "c2")).resolves.toBe("inaccessible");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("classifies Discord Missing Access separately from structural inaccessibility", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        new SessionStore(f),
        new ChannelRegistry("c1", "g1", registryFile)
      );
      (app as unknown as {
        discord: { channels: { fetch(id: string): Promise<unknown> } };
      }).discord = {
        channels: {
          async fetch() {
            throw { code: 50001 };
          },
        },
      };

      await expect(classifyThread(app, "t1", "c1")).resolves.toBe("no-access");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("classifies an obfuscated Gateway channel as retryable missing access", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        new SessionStore(f),
        new ChannelRegistry("c1", "g1", registryFile)
      );
      (app as unknown as {
        discord: { channels: { fetch(id: string): Promise<unknown> } };
      }).discord = {
        channels: {
          async fetch() {
            return {
              name: "___hidden___",
              flags: 1 << 17,
              isThread: () => false,
              guildId: "g1",
              parentId: null,
            };
          },
        },
      };

      await expect(classifyThread(app, "t1", "c1")).resolves.toBe("no-access");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("corrupt store → reconcile THROWS (startup fails closed)", async () => {
    const f = tmpFile();
    try {
      writeFileSync(f, "{ not valid json", "utf8");
      const store = new SessionStore(f);
      expect(store.isCorrupt()).toBe(true);
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await expect(reconcile(app, async () => "valid")).rejects.toThrow(/corrupt/i);
    } finally {
      rmSync(f, { force: true });
    }
  });
});

describe("reconcileOnStartup with MANY sessions (concurrency)", () => {
  it("resumes EVERY active record, not just the first", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      for (const id of ["t1", "t2", "t3"]) {
        store.reserve(wtBind(id, { generation: 1 }));
        store.commit(id);
      }
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      expect([...sessionsOf(app).keys()].sort()).toEqual(["t1", "t2", "t3"]);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("one unusable record does NOT stop the others from coming back", async () => {
    // Before this, a single bad row aborted the whole loop and every other
    // thread stayed dead until someone noticed.
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      for (const id of ["t1", "bad", "t3"]) {
        store.reserve(wtBind(id, { generation: 1 }));
        store.commit(id);
      }
      const copilot = fakeCopilot({ resumeError: (id) => (id === "s-bad" ? "boom" : undefined) });
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, copilot, new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).has("t1")).toBe(true);
      expect(sessionsOf(app).has("t3")).toBe(true);
      expect(sessionsOf(app).has("bad")).toBe(false);
      expect(store.get("bad")?.state).toBe("active"); // transient → retried later
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("resumes each session into ITS OWN recorded workDir", async () => {
    // Resuming a worktree session into another session's directory would run
    // one thread's conversation against another thread's files. The workDir must
    // be one `bindingOk` accepts, i.e. under the real worktree root.
    const f = tmpFile();
    const wt = join(`${stateDir()}-worktrees`, `test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(wt, { recursive: true });
    try {
      resumeCalls.length = 0;
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t1", sessionId: "s-1", workDir: wt, branch: "copilot/t-1" }));
      store.commit("t1");
      store.reserve(bind({ threadId: "t2", sessionId: "s-2", workDir: REPO }));
      store.commit("t2");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      const byId = Object.fromEntries(resumeCalls.map((c) => [c.id, c.cfg["workingDirectory"]]));
      expect(byId["s-1"]).toBe(wt);
      expect(byId["s-2"]).toBe(REPO);
    } finally {
      rmSync(f, { force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("passes disabled skill sources into a resumed actor even when its worktree has a skill", async () => {
    const f = tmpFile();
    const wt = join(`${stateDir()}-worktrees`, `skill-source-${Math.random().toString(36).slice(2)}`);
    try {
      const skillDir = join(wt, ".github", "skills", "probe");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: probe\n---\n");
      resumeCalls.length = 0;
      const store = new SessionStore(f);
      store.reserve(bind({ sessionId: "s-skill", workDir: wt, branch: "copilot/t-skill" }));
      store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);

      await reconcile(app, async () => "valid");

      const call = resumeCalls.find((entry) => entry.id === "s-skill")?.cfg;
      expect(call?.["enableConfigDiscovery"]).toBe(false);
      expect(call?.["enableSkills"]).toBe(false);
      expect(call?.["excludedTools"]).toEqual(["skill"]);
      expect(call?.["skillDirectories"]).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("BLOCKS a second local-mode record on the same repo instead of resuming both", async () => {
    // Two agents in one checkout silently overwrite each other, and a
    // `git checkout` in one destroys the other's uncommitted work. The lease has
    // to be taken while records are READ, not as a side effect of a successful
    // resume — see the pre-scan in reconcileOnStartup.
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "first", sessionId: "s-first" }));
      store.commit("first");
      store.reserve(bind({ threadId: "second", sessionId: "s-second" }));
      store.commit("second");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).has("first")).toBe(true);
      expect(sessionsOf(app).has("second")).toBe(false);
      expect(store.get("second")?.state).toBe("blocked");
      expect(store.get("second")?.reason).toBe("local-conflict");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("lets two WORKTREE records share a repo — that is what worktrees are for", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(wtBind("a"));
      store.commit("a");
      store.reserve(wtBind("b"));
      store.commit("b");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).has("a")).toBe(true);
      expect(sessionsOf(app).has("b")).toBe(true);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("REFUSES to resume a record whose workDir was tampered with", async () => {
    // The store is plain JSON in the user's home. A record edited to point
    // somewhere else must not resume an agent into an arbitrary directory.
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t1", sessionId: "s-1", workDir: join(tmpdir(), "dcs-fixture-somewhere-else") }));
      store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), new FakeTransport(), store);
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).has("t1")).toBe(false);
      expect(store.get("t1")?.state).toBe("blocked");
      expect(store.get("t1")?.reason).toBe("config-mismatch");
    } finally {
      rmSync(f, { force: true });
    }
  });
});

describe("startup announcement for records whose thread is gone", () => {
  // Every other reconcile notice is posted into rec.threadId — exactly what is
  // missing when the reason is `thread-gone`. Without a parent-channel line
  // those records (one full checkout each) accumulate in total silence.
  class KeyedTransport extends FakeTransport {
    sent: Array<{ key: string; text: string }> = [];
    rejectedKeys = new Set<string>();
    override async noticeDelivered(k: string, t: string): Promise<boolean> {
      this.sent.push({ key: k, text: t });
      return !this.rejectedKeys.has(k);
    }
  }

  it("posts ONE parent-channel line naming the thread id and its worktree", async () => {
    const f = tmpFile();
    const wt = join(`${stateDir()}-worktrees`, "dead"); // where bindingOk requires it to be
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "dead", workDir: wt, branch: "copilot/t-dead" }));
      store.commit("dead");
      const transport = new KeyedTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      await reconcile(app, async () => "gone");

      const parent = transport.sent.filter((m) => m.key === "c1");
      expect(parent).toHaveLength(1);
      expect(parent[0]!.text).toContain("dead"); // the id you must pass to /end
      expect(parent[0]!.text).toContain(wt); // the disk it holds
      expect(parent[0]!.text).toContain("/end thread:"); // how to reclaim it
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("announces a terminal stale rebind pointer instead of reporting its worktree as unowned", async () => {
    const f = tmpFile();
    const wt = join(`${stateDir()}-worktrees`, "stale-old");
    try {
      const store = new SessionStore(f);
      store.reserve(
        bind({
          threadId: "stale",
          sessionId: "old-session",
          generation: 1,
          workDir: wt,
          branch: "copilot/t-stale",
        })
      );
      store.commit("stale");
      const old = store.get("stale")!;
      expect(store.retainStaleRebind(old, "rebind-teardown-unconfirmed")).toBe(true);
      expect(store.remove("stale")).toBe(true);

      const transport = new KeyedTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      await reconcile(app, async () => "valid");

      const parent = transport.sent.filter((m) => m.key === "c1");
      expect(parent).toHaveLength(1);
      expect(parent[0]!.text).toContain("stale");
      expect(parent[0]!.text).toContain("舊 incarnation");
      expect(parent[0]!.text).toContain(wt);
      expect(parent[0]!.text).not.toContain("沒有對應的 session 記錄");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("stays silent when nothing is unreachable", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const transport = new KeyedTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      await reconcile(app, async () => "valid");
      expect(transport.sent.filter((m) => m.key === "c1")).toHaveLength(0);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("groups records by their enabled parent channel", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      for (const [threadId, parentChannelId] of [
        ["seed-record", "c1"],
        ["secondary-record", "c2"],
      ] as const) {
        store.reserve(bind({ threadId, parentChannelId, workDir: join(`${stateDir()}-worktrees`, threadId) }));
        store.commit(threadId);
        store.setState(threadId, "blocked", "thread-gone");
      }
      const channels = new ChannelRegistry("c1", "g1", registryFile);
      expect(channels.enable("c2", "u1")).toBe(true);
      const transport = new KeyedTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store, channels);

      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();

      expect(transport.sent).toHaveLength(2);
      const seed = transport.sent.find((notice) => notice.key === "c1")!;
      const secondary = transport.sent.find((notice) => notice.key === "c2")!;
      expect(seed.text).toContain("seed-record");
      expect(seed.text).not.toContain("secondary-record");
      expect(secondary.text).toContain("secondary-record");
      expect(secondary.text).not.toContain("seed-record");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("retries a failed direct parent notice through the seed channel", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "secondary-record", parentChannelId: "c2" }));
      store.commit("secondary-record");
      store.setState("secondary-record", "blocked", "thread-gone");
      const channels = new ChannelRegistry("c1", "g1", registryFile);
      expect(channels.enable("c2", "u1")).toBe(true);
      const transport = new KeyedTransport();
      transport.rejectedKeys.add("c2");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store, channels);

      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();

      expect(transport.sent.map((notice) => notice.key)).toEqual(["c2", "c1"]);
      expect(transport.sent[0]!.text).toContain("secondary-record");
      expect(transport.sent[1]!.text).toBe(transport.sent[0]!.text);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("uses the seed channel when a record's direct parent is no longer enabled", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "disabled-parent-record", parentChannelId: "c2" }));
      store.commit("disabled-parent-record");
      store.setState("disabled-parent-record", "blocked", "thread-gone");
      const transport = new KeyedTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );

      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();

      expect(transport.sent.map((notice) => notice.key)).toEqual(["c1"]);
      expect(transport.sent[0]!.text).toContain("disabled-parent-record");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("reports a config-mismatch record from a disabled parent through noticeDelivered to the seed", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "mismatched-parent-record", parentChannelId: "c2" }));
      store.commit("mismatched-parent-record");
      store.setState("mismatched-parent-record", "blocked", "config-mismatch");
      const transport = new KeyedTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );

      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();

      expect(transport.sent.map((notice) => notice.key)).toEqual(["c1"]);
      expect(transport.sent[0]!.text).toContain("mismatched-parent-record");
      expect(transport.notices).toEqual([]);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("logs when neither a direct parent nor its seed fallback can receive the report", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "unreachable-record", parentChannelId: "c2" }));
      store.commit("unreachable-record");
      store.setState("unreachable-record", "blocked", "thread-gone");
      const channels = new ChannelRegistry("c1", "g1", registryFile);
      expect(channels.enable("c2", "u1")).toBe(true);
      const transport = new KeyedTransport();
      transport.rejectedKeys.add("c2");
      transport.rejectedKeys.add("c1");
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store, channels);

      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not deliver"));
    } finally {
      warn.mockRestore();
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("reports unowned stray worktrees to the seed channel", async () => {
    const f = tmpFile();
    const stray = join(`${stateDir()}-worktrees`, "unowned");
    try {
      mkdirSync(stray, { recursive: true });
      writeFileSync(join(stray, ".git"), "gitdir: nowhere", "utf8");
      const transport = new KeyedTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, new SessionStore(f));

      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();

      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.key).toBe("c1");
      expect(transport.sent[0]!.text).toContain(stray);
    } finally {
      rmSync(f, { force: true });
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("a record retired by reclaim stays announceable", () => {
  // reclaim() retires a kept-worktree record via setState(..., "blocked", reason),
  // and setState OVERWRITES reason. If that erases `thread-gone`, the record drops
  // out of the startup announcement (which keys on the thread-* reasons) AND out
  // of the stray-directory list (which excludes any dir a record mentions) — so
  // the one leftover whose thread you cannot type into goes silent for ever.
  class KeyedTransport2 extends FakeTransport {
    sent: Array<{ key: string; text: string }> = [];
    override async noticeDelivered(k: string, t: string): Promise<boolean> {
      this.sent.push({ key: k, text: t });
      return true;
    }
  }

  it("keeps the thread-* diagnosis when the worktree is kept", async () => {
    const f = tmpFile();
    const wt = join(`${stateDir()}-worktrees`, "kept");
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "kept", workDir: wt, branch: "copilot/t-kept" }));
      store.commit("kept");
      const transport = new KeyedTransport2();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      await reconcile(app, async () => "gone");
      expect(store.get("kept")?.reason).toBe("thread-gone");

      // The worktree does not exist here, so reclaim takes the already-absent
      // path; force the "kept" branch by retiring the record the same way.
      (app as unknown as { retire(id: string): boolean }).retire("kept");
      const rec = store.get("kept");
      expect(rec?.state).toBe("blocked");
      expect(rec?.reason).toBe("thread-gone"); // diagnosis survives

      transport.sent.length = 0;
      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();
      const parent = transport.sent.filter((m) => m.key === "c1");
      expect(parent).toHaveLength(1);
      expect(parent[0]!.text).toContain("kept"); // still discoverable at boot
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("announces a record retired from a live session too (it still holds disk)", async () => {
    const f = tmpFile();
    const wt = join(`${stateDir()}-worktrees`, "live-end");
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "live-end", workDir: wt, branch: "copilot/t-live-end" }));
      store.commit("live-end"); // active, no reason
      const transport = new KeyedTransport2();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      (app as unknown as { retire(id: string): boolean }).retire("live-end");
      expect(store.get("live-end")?.reason).toBe("worktree-kept");

      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();
      expect(transport.sent.filter((m) => m.key === "c1")).toHaveLength(1);
    } finally {
      rmSync(f, { force: true });
    }
  });
});

describe("startup announcement length budget", () => {
  class Cap extends FakeTransport {
    sent: string[] = [];
    override async noticeDelivered(_k: string, t: string): Promise<boolean> {
      this.sent.push(t);
      return true;
    }
  }
  it("budgets the composed notice before transport truncation, and says how many it left out", async () => {
    // A fixed count cap does not bound a message built from 19-digit snowflakes
    // and absolute paths: the 15 realistic entries per parent below exceed the
    // budget, so the last ids AND the instruction line would be silently
    // dropped — in a message whose entire job is to name ids.
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      for (const parentChannelId of ["c1", "c2"]) {
        for (let i = 0; i < 15; i++) {
          const id = `${parentChannelId}-153200000000000${String(i).padStart(4, "0")}`;
          store.reserve(
            bind({
              threadId: id,
              parentChannelId,
              workDir: join(`${stateDir()}-worktrees`, id),
              branch: `copilot/t-${id}`,
            })
          );
          // Formatting-only fixture: the intermediate active state is irrelevant.
          store.setState(id, "blocked", "thread-gone");
        }
      }
      const transport = new Cap();
      const channels = new ChannelRegistry("c1", "g1", registryFile);
      expect(channels.enable("c2", "u1")).toBe(true);
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store, channels);
      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();
      expect(transport.sent).toHaveLength(2);
      for (const msg of transport.sent) {
        expect(msg.length).toBeLessThanOrEqual(1850);
        expect(msg).toContain("另有"); // admits what it omitted
        expect(msg).toContain("/end thread:"); // the instruction survives the cut
      }
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Same-process access-restoration retry (ADR-0002)
// ---------------------------------------------------------------------------

/** One scheduled retry wake-up, captured instead of slept through. */
interface FakeRetryJob {
  fn: () => void;
  ms: number;
  handle: object;
}

/** Replace the retry loop's timer with a queue a test can fire by hand. Real
 *  waits would make this suite either slow or flaky, and `vi.useFakeTimers()`
 *  would also freeze the SDK/git timeouts the same app owns. */
function installFakeScheduler(app: DiscordCopilotApp): FakeRetryJob[] {
  const jobs: FakeRetryJob[] = [];
  (
    app as unknown as {
      accessRetryScheduler: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
    }
  ).accessRetryScheduler = {
    set(fn: () => void, ms: number): unknown {
      const handle = {};
      jobs.push({ fn, ms, handle });
      return handle;
    },
    clear(h: unknown): void {
      const i = jobs.findIndex((j) => j.handle === h);
      if (i >= 0) jobs.splice(i, 1);
    },
  };
  return jobs;
}

/** What `onReady` does once reconciliation is finished. */
function readyAndStartRetry(app: DiscordCopilotApp): void {
  (app as unknown as { phase: string }).phase = "ready";
  (app as unknown as { startAccessRetryLoop(): void }).startAccessRetryLoop();
}

/** Fire the next scheduled wake-up and wait for the tick it starts. */
async function fireRetry(app: DiscordCopilotApp, jobs: FakeRetryJob[]): Promise<void> {
  await beginRetry(app, jobs);
}

/** Fire the next wake-up WITHOUT waiting, so a test can act while the tick is
 *  suspended inside the runtime — which is where every race here lives. */
function beginRetry(app: DiscordCopilotApp, jobs: FakeRetryJob[]): Promise<void> {
  const job = jobs.shift();
  expect(job, "expected a scheduled retry wake-up").toBeDefined();
  job?.fn();
  return (
    (app as unknown as { accessRetryTickPromise?: Promise<void> }).accessRetryTickPromise ??
    Promise.resolve()
  );
}

/** A stray timer fire, as a second armed timer or an event poke would produce. */
function runRetryTick(app: DiscordCopilotApp): void {
  (app as unknown as { runAccessRetryTick(): void }).runAccessRetryTick();
}

/** A copilot whose resume is held open until the test releases it, so `/end`
 *  and shutdown can be driven while a resume really is in flight. */
function gatedCopilot(opts: { disconnectError?: string; disconnectFails?: () => boolean } = {}): {
  client: CopilotClient;
  calls: string[];
  release: () => void;
  disconnects: () => number;
} {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const calls: string[] = [];
  let disconnects = 0;
  const session = {
    ...fakeSession,
    async disconnect(): Promise<void> {
      disconnects++;
      if (opts.disconnectError ?? opts.disconnectFails?.()) {
        throw new Error(opts.disconnectError ?? "runtime is not responding");
      }
    },
  };
  return {
    client: {
      createSession: async () => session,
      async stop(): Promise<void> {},
      resumeSession: async (id: string) => {
        calls.push(id);
        await gate;
        return session;
      },
    } as unknown as CopilotClient,
    calls,
    release: () => open(),
    disconnects: () => disconnects,
  };
}

/** The slice of a slash-command interaction `/end thread:<id>` actually uses. */
function fakeInteraction(): { replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    async reply(o: { content: string }): Promise<void> {
      replies.push(o.content);
    },
    async deferReply(): Promise<void> {},
    async editReply(o: string | { content: string }): Promise<void> {
      replies.push(typeof o === "string" ? o : o.content);
    },
  } as unknown as { replies: string[] };
}

/** Reconcile through the REAL `classifyThread`, so these tests exercise the
 *  actual 50001/obfuscation classification rather than an injected verdict. */
function reconcileReal(app: DiscordCopilotApp): Promise<void> {
  return (
    app as unknown as {
      reconcileOnStartup(d?: { validateBinding?: () => Promise<unknown> }): Promise<void>;
    }
  ).reconcileOnStartup({ validateBinding: async () => ({ ok: true }) });
}

/** Records every channel fetch, so a test can wait for the retry tick to have
 *  actually reached the classification await before it acts. */
const fetchCalls: Array<{ id: string; force: boolean }> = [];

function setChannelFetch(
  app: DiscordCopilotApp,
  fetch: (id: string, options?: { force?: boolean }) => Promise<unknown>
): void {
  (app as unknown as {
    discord: { channels: { fetch(id: string, options?: { force?: boolean }): Promise<unknown> } };
  }).discord = {
    channels: {
      async fetch(id: string, options?: { force?: boolean }): Promise<unknown> {
        fetchCalls.push({ id, force: options?.force === true });
        return fetch(id, options);
      },
    },
  };
}

const visibleThread = {
  isThread: () => true,
  guildId: "g1",
  parentId: "c1",
  archived: false,
  sendable: true,
};

describe("same-process access-restoration retry (ADR-0002)", () => {
  it("resumes a 50001 no-access record exactly once, once access is restored", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind());
      store.commit("t1");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      expect(store.get("t1")?.state).toBe("active");
      expect(store.get("t1")?.reason).toBe("thread-no-access");
      expect(sessionsOf(app).has("t1")).toBe(false);

      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      expect(jobs.map((j) => j.ms)).toEqual([15_000]);

      // Still no access: nothing changes, and the thread is not spammed.
      const noticesBefore = transport.notices.length;
      const resumesBefore = resumeCalls.filter((c) => c.id === "sess-1").length;
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t1")).toBe(false);
      expect(store.get("t1")?.state).toBe("active");
      expect(store.get("t1")?.reason).toBe("thread-no-access");
      expect(transport.notices.length).toBe(noticesBefore);
      expect(resumeCalls.filter((c) => c.id === "sess-1").length).toBe(resumesBefore);

      access = true;
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t1")).toBe(true);
      expect(resumeCalls.filter((c) => c.id === "sess-1").length).toBe(resumesBefore + 1);
      expect(store.get("t1")?.state).toBe("active");
      expect(store.get("t1")?.reason).toBeUndefined(); // retry state cleared

      // A later wake-up must not resume the same record a second time.
      await fireRetry(app, jobs);
      expect(resumeCalls.filter((c) => c.id === "sess-1").length).toBe(resumesBefore + 1);
      expect(sessionsOf(app).size).toBe(1);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("resumes an obfuscated-channel record once the channel becomes visible again", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-obf", sessionId: "sess-obf" }));
      store.commit("t-obf");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let hidden = true;
      setChannelFetch(app, async () =>
        hidden ? { name: "___hidden___", isThread: () => true, guildId: "g1", parentId: "c1" } : visibleThread
      );

      await reconcileReal(app);
      expect(store.get("t-obf")?.reason).toBe("thread-no-access");

      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t-obf")).toBe(false);

      hidden = false;
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t-obf")).toBe(true);
      expect(resumeCalls.filter((c) => c.id === "sess-obf")).toHaveLength(1);
      expect(store.get("t-obf")?.state).toBe("active");
      expect(store.get("t-obf")?.reason).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("stays active/thread-no-access for ever while access stays revoked, and backs off", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-stuck", sessionId: "sess-stuck" }));
      store.commit("t-stuck");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      setChannelFetch(app, async () => {
        throw { code: 50001 };
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      const noticesAfterStartup = transport.notices.length;

      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        delays.push(jobs[0]?.ms ?? -1);
        await fireRetry(app, jobs);
      }
      // Escalating, capped, and never terminal.
      expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
      expect(jobs.map((j) => j.ms)).toEqual([300_000]);
      expect(store.get("t-stuck")?.state).toBe("active");
      expect(store.get("t-stuck")?.reason).toBe("thread-no-access");
      expect(sessionsOf(app).size).toBe(0);
      expect(resumeCalls.filter((c) => c.id === "sess-stuck")).toHaveLength(0);
      // No per-wake-up spam into a thread the bot cannot even reach.
      expect(transport.notices.length).toBe(noticesAfterStartup);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("persists the existing terminal outcome when the thread turns out to be gone", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-gone", sessionId: "sess-gone" }));
      store.commit("t-gone");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let deleted = false;
      setChannelFetch(app, async () => {
        if (!deleted) throw { code: 50001 };
        throw { code: 10003 };
      });

      await reconcileReal(app);
      expect(localLeasesOf(app).size).toBe(1); // local-mode record holds its repo
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);

      deleted = true;
      await fireRetry(app, jobs);
      expect(store.get("t-gone")?.state).toBe("blocked");
      expect(store.get("t-gone")?.reason).toBe("thread-gone");
      expect(sessionsOf(app).has("t-gone")).toBe(false);
      expect(localLeasesOf(app).size).toBe(0); // terminal ⇒ the repo is free again
      expect(resumeCalls.filter((c) => c.id === "sess-gone")).toHaveLength(0);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("cannot double-resume when a second wake-up lands inside one already in flight", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-race", sessionId: "sess-race" }));
      store.commit("t-race");
      const gated = gatedCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(gated.calls).toHaveLength(1));
      // Two more wake-ups while the first tick is suspended in the runtime.
      runRetryTick(app);
      runRetryTick(app);
      expect(gated.calls).toHaveLength(1);
      expect(jobs).toHaveLength(0); // nothing re-armed while a tick is in flight

      gated.release();
      await tick;

      expect(gated.calls).toEqual(["sess-race"]);
      expect(sessionsOf(app).size).toBe(1);
      expect(sessionsOf(app).has("t-race")).toBe(true);
      expect(gated.disconnects()).toBe(0);
      expect(store.get("t-race")?.state).toBe("active");
      expect(jobs).toHaveLength(1); // exactly ONE wake-up re-armed
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("lets /end win against an in-flight retry instead of resurrecting the record", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-end", sessionId: "sess-end" }));
      store.commit("t-end");
      const gated = gatedCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(gated.calls).toHaveLength(1));

      // `/end thread:t-end` from the parent channel, while the resume is in the
      // runtime. ADR-0002 makes this the owner's deliberate escape hatch, and it
      // claims the thread synchronously — before its own first await — so the
      // resume in flight is already beaten.
      const interaction = fakeInteraction();
      const ending = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(interaction, "t-end");
      gated.release();
      await ending;
      expect(store.get("t-end")).toBeUndefined();

      await tick;

      expect(store.get("t-end")).toBeUndefined(); // NOT resurrected
      expect(sessionsOf(app).has("t-end")).toBe(false);
      expect(localLeasesOf(app).size).toBe(0);
      expect(gated.disconnects()).toBe(1); // the orphaned resume was torn down
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("starts no session, and arms no further wake-up, when shutdown races a retry", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-shut", sessionId: "sess-shut" }));
      store.commit("t-shut");
      const gated = gatedCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(gated.calls).toHaveLength(1));

      // `stop()` disarms the timer AND joins the tick already in flight, so
      // nothing may still be mutating the store once it resolves.
      const stopping = app.stop();
      gated.release();
      await stopping;
      const afterStop = JSON.stringify(store.get("t-shut"));

      await tick;

      expect(JSON.stringify(store.get("t-shut"))).toBe(afterStop); // no late write
      expect(sessionsOf(app).size).toBe(0);
      expect(gated.disconnects()).toBe(1);
      expect(jobs).toHaveLength(0); // disarmed, and never re-armed after shutdown
      // Untouched, so the next boot still finds a resumable conversation.
      expect(store.get("t-shut")?.state).toBe("active");
      expect(store.get("t-shut")?.reason).toBe("thread-no-access");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("does not arm a wake-up that can hold the process open", () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        new SessionStore(f),
        new ChannelRegistry("c1", "g1", registryFile)
      );
      (app as unknown as { phase: string }).phase = "ready";
      (app as unknown as { startAccessRetryLoop(): void }).startAccessRetryLoop();
      const timer = (app as unknown as { accessRetryTimer?: { hasRef?(): boolean } }).accessRetryTimer;
      expect(timer?.hasRef?.()).toBe(false);
      (app as unknown as { clearAccessRetryTimer(): void }).clearAccessRetryTimer();
      expect((app as unknown as { accessRetryTimer?: unknown }).accessRetryTimer).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("keeps a record eligible after a TRANSIENT classification instead of parking it until restart", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-tr", sessionId: "sess-tr" }));
      store.commit("t-tr");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let mode: "no-access" | "transient" | "ok" = "no-access";
      setChannelFetch(app, async () => {
        if (mode === "no-access") throw { code: 50001 };
        if (mode === "transient") throw { status: 500 };
        return visibleThread;
      });

      await reconcileReal(app);
      expect(store.get("t-tr")?.reason).toBe("thread-no-access");
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      const noticesAfterStartup = transport.notices.length;

      // A 5xx/429 blip during a retry attempt must NOT rewrite the reason: the
      // loop's own candidate filter and `/end`'s ADR-0002 escape hatch both key
      // on `thread-no-access`, so rewriting it parks the record until a restart.
      mode = "transient";
      await fireRetry(app, jobs);
      expect(store.get("t-tr")?.state).toBe("active");
      expect(store.get("t-tr")?.reason).toBe("thread-no-access");
      expect(sessionsOf(app).has("t-tr")).toBe(false);
      expect(transport.notices.length).toBe(noticesAfterStartup); // no spam
      expect(jobs.map((j) => j.ms)).toEqual([30_000]); // still backing off, still armed

      await fireRetry(app, jobs);
      expect(store.get("t-tr")?.reason).toBe("thread-no-access");

      mode = "ok";
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t-tr")).toBe(true);
      expect(resumeCalls.filter((c) => c.id === "sess-tr")).toHaveLength(1);
      expect(store.get("t-tr")?.reason).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("keeps a record eligible after an UNKNOWN thread status too", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-unk", sessionId: "sess-unk" }));
      store.commit("t-unk");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let status = "no-access";
      await reconcile(app, async () => status);
      expect(store.get("t-unk")?.reason).toBe("thread-no-access");

      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      const noticesAfterStartup = transport.notices.length;

      // planReconcile's defensive default (`unknown-thread-status`) must not be
      // able to park a record either.
      status = "something-new-from-a-future-sdk";
      await fireRetry(app, jobs);
      expect(store.get("t-unk")?.state).toBe("active");
      expect(store.get("t-unk")?.reason).toBe("thread-no-access");
      expect(sessionsOf(app).has("t-unk")).toBe(false);
      expect(transport.notices.length).toBe(noticesAfterStartup);

      status = "valid";
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t-unk")).toBe(true);
      expect(store.get("t-unk")?.reason).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("does not recreate a worktree /end just removed while the retry was classifying", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const wt = wtBind("t-wt", { sessionId: "sess-wt" });
      store.reserve(wt);
      store.commit("t-wt");
      const gated = gatedCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      let holdClassify: Promise<void> | undefined;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        if (holdClassify) await holdClassify;
        return visibleThread;
      });

      await reconcileReal(app);
      expect(store.get("t-wt")?.reason).toBe("thread-no-access");
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);

      access = true;
      let releaseClassify: () => void = () => {};
      holdClassify = new Promise<void>((r) => {
        releaseClassify = r;
      });
      const before = addWorktreeCalls.length;
      const fetchesBefore = fetchCalls.length;
      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(fetchCalls.length).toBeGreaterThan(fetchesBefore));

      // The worktree is already gone (hand-deleted / disk cleaned), so `/end`
      // reaps the record outright — the exact shape that used to let the resume
      // rebuild a checkout nothing owns.
      rmSync(wt.workDir, { recursive: true, force: true });
      const ending = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(fakeInteraction(), "t-wt");
      releaseClassify();
      await ending;
      expect(store.get("t-wt")).toBeUndefined();

      await tick;

      expect(addWorktreeCalls.length).toBe(before); // never even attempted
      expect(existsSync(wt.workDir)).toBe(false); // no resurrected checkout
      expect(store.get("t-wt")).toBeUndefined();
      expect(sessionsOf(app).has("t-wt")).toBe(false);
      expect(gated.calls).toHaveLength(0); // no SDK session was created either
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("does not recreate a worktree when shutdown races the same window", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const wt = wtBind("t-wt-shut", { sessionId: "sess-wt-shut" });
      store.reserve(wt);
      store.commit("t-wt-shut");
      const gated = gatedCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      let holdClassify: Promise<void> | undefined;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        if (holdClassify) await holdClassify;
        return visibleThread;
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);

      access = true;
      let releaseClassify: () => void = () => {};
      holdClassify = new Promise<void>((r) => {
        releaseClassify = r;
      });
      const before = addWorktreeCalls.length;
      const fetchesBefore = fetchCalls.length;
      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(fetchCalls.length).toBeGreaterThan(fetchesBefore));

      rmSync(wt.workDir, { recursive: true, force: true });
      const stopping = app.stop();
      releaseClassify();
      await stopping;

      await tick;

      expect(addWorktreeCalls.length).toBe(before);
      expect(existsSync(wt.workDir)).toBe(false);
      expect(gated.calls).toHaveLength(0);
      expect(sessionsOf(app).size).toBe(0);
      expect(jobs).toHaveLength(0);
      // Untouched on disk, so the next boot still finds it resumable.
      expect(store.get("t-wt-shut")?.state).toBe("active");
      expect(store.get("t-wt-shut")?.reason).toBe("thread-no-access");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

describe("startup skip notices promise only what will actually happen", () => {
  /** Reconcile ONE active record to a `skip` and return the notice it posted. */
  async function skipNotice(threadId: string, status: string): Promise<string> {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId, sessionId: `s-${threadId}` }));
      store.commit(threadId);
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      await reconcile(app, async () => status);
      expect(store.get(threadId)?.state).toBe("active");
      expect(transport.notices).toHaveLength(1);
      return transport.notices[0] ?? "";
    } finally {
      rmSync(f, { force: true });
    }
  }

  it("tells a no-access thread that restoring access is enough, with no restart", async () => {
    const text = await skipNotice("t-n1", "no-access");
    expect(text).toContain("存取權");
    expect(text).toContain("自動");
    expect(text).toContain("不必重啟");
    expect(text).toContain("/end thread:"); // ADR-0002's escape hatch stays visible
  });

  it("does NOT promise a transient record an access-restoration retry it never gets", async () => {
    // Only `thread-no-access` is in the runtime loop's candidate set; a transient
    // fetch failure is retried by a RESTART. The shared copy used to tell this
    // record that restoring access would bring it back, which is simply untrue.
    const text = await skipNotice("t-n2", "transient");
    expect(text).toContain("重新啟動");
    expect(text).not.toContain("恢復存取權");
    expect(text).toContain("transient-thread-fetch"); // says which diagnosis it is
  });

  it("says the same honest thing for an unclassifiable status", async () => {
    const text = await skipNotice("t-n3", "something-new-from-a-future-sdk");
    expect(text).toContain("重新啟動");
    expect(text).not.toContain("恢復存取權");
    expect(text).toContain("unknown-thread-status");
  });
});

describe("access retry must not trust the channel cache", () => {
  it("forces a REST fetch, so a cached obfuscated stub cannot hide restored access for ever", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-cache", sessionId: "sess-cache" }));
      store.commit("t-cache");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      // discord.js answers `channels.fetch(id)` from cache when it holds a
      // non-partial object. Losing access leaves an OBFUSCATED stub cached, and
      // regaining access does not necessarily replace that exact thread object —
      // so an unforced fetch can report "hidden" for ever while the bot can
      // really see the thread again.
      let access = false;
      const cachedObfuscatedStub = {
        name: "___hidden___",
        isThread: () => true,
        guildId: "g1",
        parentId: "c1",
      };
      setChannelFetch(app, async (_id, options) => {
        if (options?.force !== true) return cachedObfuscatedStub;
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      expect(store.get("t-cache")?.reason).toBe("thread-no-access");

      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;
      const forcedBefore = fetchCalls.filter((c) => c.force).length;

      await fireRetry(app, jobs);

      expect(fetchCalls.filter((c) => c.force).length).toBe(forcedBefore + 1);
      expect(sessionsOf(app).has("t-cache")).toBe(true);
      expect(resumeCalls.filter((c) => c.id === "sess-cache")).toHaveLength(1);
      expect(store.get("t-cache")?.reason).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("leaves the startup pass on the ordinary cached path", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-boot", sessionId: "sess-boot" }));
      store.commit("t-boot");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      setChannelFetch(app, async () => visibleThread);
      const before = fetchCalls.length;
      await reconcileReal(app);
      expect(fetchCalls.slice(before).every((c) => !c.force)).toBe(true);
      expect(sessionsOf(app).has("t-boot")).toBe(true);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

describe("access retry vs an explicit teardown that started FIRST", () => {
  /** A `/end` interaction whose deferral the test controls, so the retry loop
   *  really does run inside `/end`'s awaits — the ordering that used to leave a
   *  live session behind with no durable record. */
  function gatedInteraction(): { iface: unknown; release: () => void; replies: string[] } {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const replies: string[] = [];
    return {
      iface: {
        async reply(o: { content: string }): Promise<void> {
          await gate;
          replies.push(o.content);
        },
        async deferReply(): Promise<void> {
          await gate;
        },
        async editReply(o: string | { content: string }): Promise<void> {
          replies.push(typeof o === "string" ? o : o.content);
        },
      },
      release: () => open(),
      replies,
    };
  }

  it("leaves no live session without a record when /end is already in flight", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-first", sessionId: "sess-first" }));
      store.commit("t-first");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async (_id, options) => {
        if (!access && options?.force !== true) throw { code: 50001 };
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      expect(localLeasesOf(app).size).toBe(1);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      // `/end` starts first and is suspended in its own deferral — the record is
      // still `active`/`thread-no-access` on disk, so the loop would happily
      // resume it and register a session this command then orphans.
      const ending = gatedInteraction();
      const endPromise = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(ending.iface, "t-first");
      expect(store.get("t-first")?.state).toBe("active"); // not removed yet

      await fireRetry(app, jobs);

      expect(sessionsOf(app).has("t-first")).toBe(false);
      expect(resumeCalls.filter((c) => c.id === "sess-first")).toHaveLength(0);

      ending.release();
      await endPromise;

      expect(store.get("t-first")).toBeUndefined();
      expect(sessionsOf(app).has("t-first")).toBe(false);
      expect(localLeasesOf(app).size).toBe(0); // lease released with the record
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("frees the record again when the /end that claimed it fails", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-freed", sessionId: "sess-freed" }));
      store.commit("t-freed");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });
      await reconcileReal(app);
      expect(store.get("t-freed")?.reason).toBe("thread-no-access");
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      const boom = {
        async reply(): Promise<void> {
          throw new Error("interaction expired");
        },
        async deferReply(): Promise<void> {
          throw new Error("interaction expired");
        },
        async editReply(): Promise<void> {},
      };
      await expect(
        (app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }).endStaleRecord(
          boom,
          "t-freed"
        )
      ).rejects.toThrow(/interaction expired/);

      // The claim must not outlive the command: the record is still `active`,
      // so the loop that exists to bring it back has to be allowed to.
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t-freed")).toBe(true);
      expect(store.get("t-freed")?.reason).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("retains a discarded session whose teardown could NOT be confirmed", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-hung", sessionId: "sess-hung" }));
      store.commit("t-hung");
      const gated = gatedCopilot({ disconnectError: "runtime is not responding" });
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(gated.calls).toHaveLength(1));
      const interaction = fakeInteraction();
      const ending = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(interaction, "t-hung");
      gated.release();
      await ending;
      await tick;

      // A runtime we could not prove dead may still be holding the working tree
      // (and, on Windows, the root capability). Dropping the last reference to it
      // is exactly what this barrier exists to prevent — and `/end` must refuse
      // to reclaim the checkout behind it rather than delete it underneath.
      expect(sessionsOf(app).has("t-hung")).toBe(false);
      expect(hasRuntimeBarrier(app, "t-hung")).toBe(true);
      expect(store.get("t-hung")?.state).toBe("active"); // NOT reaped
      expect(interaction.replies.join("\n")).toContain("無法確認");
      expect(interaction.replies.join("\n")).toContain("重啟");
      expect(gated.disconnects()).toBeGreaterThanOrEqual(2); // discard + /end retry
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("posts the truthful transient-resume notice ONCE, not on every wake-up", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-flaky", sessionId: "sess-flaky" }));
      store.commit("t-flaky");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot({ resumeError: "getaddrinfo ENOTFOUND api.githubcopilot.com" }),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;
      const before = transport.notices.length;

      await fireRetry(app, jobs);
      await fireRetry(app, jobs);
      await fireRetry(app, jobs);

      const posted = transport.notices.slice(before);
      expect(posted).toHaveLength(1); // once per thread per process, not per tick
      expect(posted[0]).toContain("自動");
      expect(posted[0]).not.toContain("重新啟動 bot 可再嘗試"); // the loop retries, not a restart
      expect(store.get("t-flaky")?.state).toBe("active");
      expect(store.get("t-flaky")?.reason).toBe("thread-no-access"); // still eligible
      expect(sessionsOf(app).has("t-flaky")).toBe(false);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

describe("access retry — settlement, durability and teardown retries", () => {
  /** Shrink `/end`'s bounded join so the "it did not finish in time" branch is
   *  reachable without a five-second test. Safety never depended on the value:
   *  an unsettled attempt refuses, it does not proceed. */
  function shrinkJoin(app: DiscordCopilotApp, ms = 10): void {
    useOwnershipBounds(app, { joinTimeoutMs: ms });
  }

  it("refuses to reclaim when the join expires before the attempt has settled", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const wt = wtBind("t-join", { sessionId: "sess-join" });
      store.reserve(wt);
      store.commit("t-join");
      const gated = gatedCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      shrinkJoin(app);
      access = true;

      // Wedged INSIDE the runtime, i.e. before any actor exists to put in the
      // barrier. The old join raced the discard's own 5s bound and could return
      // to a `/end` that then saw an empty barrier map and reclaimed.
      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(gated.calls).toHaveLength(1));

      const interaction = fakeInteraction();
      await (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(interaction, "t-join");

      expect(interaction.replies.join("\n")).toContain("還沒結束");
      expect(store.get("t-join")?.state).toBe("active"); // NOT reclaimed
      expect(existsSync(wt.workDir)).toBe(true); // and its checkout is intact
      expect(removeWorktreeCalls.filter((c) => c.dir === wt.workDir)).toHaveLength(0);

      gated.release();
      await tick;
      // The refusal did no destructive work and cancelled nothing, so the
      // recovery simply finishes. The owner is told to try again — and can now
      // `/end` inside the thread that just came back.
      expect(sessionsOf(app).has("t-join")).toBe(true);
      expect(store.get("t-join")?.reason).toBeUndefined();
      expect(existsSync(wt.workDir)).toBe(true);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("does not register, or announce, a recovery it could not write down", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-nodisk", sessionId: "sess-nodisk" }));
      store.commit("t-nodisk");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });

      await reconcileReal(app);
      expect(localLeasesOf(app).size).toBe(1);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;
      const before = transport.notices.length;

      const commit = vi.spyOn(store, "commit").mockReturnValue(false);
      try {
        await fireRetry(app, jobs);
      } finally {
        commit.mockRestore();
      }

      // Persist-first: the record still says it was never recovered, so a live
      // session behind it would be a session no durable record admits exists.
      expect(sessionsOf(app).has("t-nodisk")).toBe(false);
      expect(store.get("t-nodisk")?.state).toBe("active");
      expect(store.get("t-nodisk")?.reason).toBe("thread-no-access"); // still eligible
      expect(localLeasesOf(app).size).toBe(1); // lease preserved with the record
      const posted = transport.notices.slice(before);
      expect(posted.some((n) => n.includes("已復原此對話"))).toBe(false); // no false success
      expect(posted.some((n) => n.includes("無法寫入磁碟"))).toBe(true);

      // And the very next wake-up recovers it for real.
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t-nodisk")).toBe(true);
      expect(store.get("t-nodisk")?.reason).toBeUndefined();
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("undoes a worktree it rebuilt when /end lands INSIDE the rebuild", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const wt = wtBind("t-mid", { sessionId: "sess-mid" });
      store.reserve(wt);
      store.commit("t-mid");
      const gated = gatedCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });
      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      // Suspend INSIDE the rebuild: the pre-check cannot cover this window, so
      // only the post-rebuild fence can stop a checkout being left behind.
      let insideRebuild: () => void = () => {};
      const entered = new Promise<void>((r) => {
        insideRebuild = r;
      });
      let releaseRebuild: () => void = () => {};
      const held = new Promise<void>((r) => {
        releaseRebuild = r;
      });
      worktreeHooks.add = async (_repo, dir) => {
        insideRebuild();
        await held;
        mkdirSync(dir, { recursive: true }); // a REAL rebuild would now exist
      };
      worktreeHooks.remove = async (_repo, dir) => {
        rmSync(dir, { recursive: true, force: true });
        return "removed";
      };

      rmSync(wt.workDir, { recursive: true, force: true });
      const addsBefore = addWorktreeCalls.length;
      const tick = beginRetry(app, jobs);
      await entered;

      const ending = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(fakeInteraction(), "t-mid");
      releaseRebuild();
      gated.release();
      await ending;
      await tick;

      expect(addWorktreeCalls.length).toBe(addsBefore + 1); // it really did rebuild
      expect(removeWorktreeCalls.some((c) => c.dir === wt.workDir)).toBe(true); // and undid it
      expect(existsSync(wt.workDir)).toBe(false);
      expect(store.get("t-mid")).toBeUndefined();
      expect(sessionsOf(app).has("t-mid")).toBe(false);
      expect(gated.calls).toHaveLength(0); // never reached the runtime
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("clears a retained barrier when shutdown's retry finally confirms it", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-bar1", sessionId: "sess-bar1" }));
      store.commit("t-bar1");
      let failDisconnect = true;
      const gated = gatedCopilot({ disconnectFails: () => failDisconnect });
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });
      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(gated.calls).toHaveLength(1));
      const ending = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(fakeInteraction(), "t-bar1");
      gated.release();
      await ending;
      await tick;
      expect(hasRuntimeBarrier(app, "t-bar1")).toBe(true);

      failDisconnect = false; // the runtime finally answers
      await app.stop();
      expect(hasRuntimeBarrier(app, "t-bar1")).toBe(false);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("keeps a retained barrier that shutdown still cannot confirm", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-bar2", sessionId: "sess-bar2" }));
      store.commit("t-bar2");
      const gated = gatedCopilot({ disconnectFails: () => true });
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        gated.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });
      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(gated.calls).toHaveLength(1));
      const ending = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(fakeInteraction(), "t-bar2");
      gated.release();
      await ending;
      await tick;
      expect(hasRuntimeBarrier(app, "t-bar2")).toBe(true);

      await app.stop();
      // Still unconfirmed ⇒ still a barrier. It is not a leak: it is the only
      // thing standing between a maybe-live runtime and its working tree.
      expect(hasRuntimeBarrier(app, "t-bar2")).toBe(true);
      expect(store.get("t-bar2")?.state).toBe("active"); // record kept with it
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("idles at the longest interval when the very first tick finds no candidate", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-none", sessionId: "sess-none" }));
      store.commit("t-none"); // active, but never parked on no-access
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let fetched = 0;
      setChannelFetch(app, async () => {
        fetched++;
        return visibleThread;
      });

      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      expect(jobs.map((j) => j.ms)).toEqual([15_000]);

      await fireRetry(app, jobs);

      expect(fetched).toBe(0); // an ordinary active record is not this loop's business
      expect(sessionsOf(app).size).toBe(0);
      expect(jobs.map((j) => j.ms)).toEqual([300_000]); // idle poll, not a 15s spin
      expect(store.get("t-none")?.state).toBe("active");

      await fireRetry(app, jobs);
      expect(jobs.map((j) => j.ms)).toEqual([300_000]); // and it stays there
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

describe("access retry must not resume behind its own unconfirmed barrier", () => {
  /** A copilot whose resumes are ungated but whose disconnect can be made to
   *  HANG — the timing the immediate-throw fakes never exercise, and the one a
   *  wedged runtime actually produces. */
  function hangingCopilot(): {
    client: CopilotClient;
    resumes: string[];
    setHanging: (v: boolean) => void;
    holdFirstResume: () => () => void;
    disconnects: () => number;
  } {
    let hanging = true;
    let disconnects = 0;
    let resumeGate: Promise<void> | undefined;
    const resumes: string[] = [];
    const makeSession = (): unknown => ({
      ...fakeSession,
      async disconnect(): Promise<void> {
        disconnects++;
        if (hanging) await new Promise<void>(() => {}); // never settles
      },
    });
    return {
      client: {
        createSession: async () => makeSession(),
        async stop(): Promise<void> {},
        resumeSession: async (id: string) => {
          resumes.push(id);
          if (resumeGate) {
            const g = resumeGate;
            resumeGate = undefined;
            await g;
          }
          return makeSession();
        },
      } as unknown as CopilotClient,
      resumes,
      /** Hold the NEXT resume open, so a test can act while it is in flight. */
      holdFirstResume: () => {
        let open: () => void = () => {};
        resumeGate = new Promise<void>((resolve) => {
          open = resolve;
        });
        return open;
      },
      setHanging: (v: boolean) => {
        hanging = v;
      },
      disconnects: () => disconnects,
    };
  }

  /** Shrink the per-attempt teardown bound so a HANGING disconnect is testable
   *  without spending the real one. The join bound is left comfortably longer,
   *  so `/end` reaches the barrier it is supposed to find rather than expiring
   *  first — that expiry has its own test. */
  function shrinkTeardown(app: DiscordCopilotApp, teardownMs = 10, joinMs = 2_000): void {
    (app as unknown as { resumeTeardownTimeoutMs: number }).resumeTeardownTimeoutMs = teardownMs;
    (app as unknown as { accessResumeJoinTimeoutMs: number }).accessResumeJoinTimeoutMs = joinMs;
  }

  it("does not resume again while an earlier runtime was never confirmed stopped", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-again", sessionId: "sess-again" }));
      store.commit("t-again");
      const copilot = hangingCopilot();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        copilot.client,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });
      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      shrinkTeardown(app);
      access = true;

      // First attempt: the resume is held open, `/end` claims the thread while it
      // is in flight, and the discard's teardown HANGS — so it is retained as a
      // barrier and `/end` refuses.
      const releaseResume = copilot.holdFirstResume();
      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(copilot.resumes).toHaveLength(1));
      const interaction = fakeInteraction();
      const ending = (
        app as unknown as { endStaleRecord(i: unknown, threadId: string): Promise<void> }
      ).endStaleRecord(interaction, "t-again");
      releaseResume();
      await tick;
      await ending;

      expect(copilot.resumes).toEqual(["sess-again"]);
      expect(interaction.replies.join("\n")).toContain("無法確認");
      expect(hasRuntimeBarrier(app, "t-again")).toBe(true);
      const retained = obligationHandle(app, "t-again");
      expect(retained).toBeDefined();
      expect(store.get("t-again")?.state).toBe("active"); // /end refused, record kept
      expect(store.get("t-again")?.reason).toBe("thread-no-access"); // still a candidate

      // SECOND wake-up. The record is still a candidate, so without the barrier
      // gate the loop would resume the same session again, build a second actor
      // for one worktree, and overwrite the only reference fencing the first.
      await fireRetry(app, jobs);

      expect(copilot.resumes).toEqual(["sess-again"]); // no second resume
      expect(sessionsOf(app).size).toBe(0);
      expect(obligationHandle(app, "t-again")).toBe(retained); // same retained identity
      expect(store.get("t-again")?.state).toBe("active");
      expect(store.get("t-again")?.reason).toBe("thread-no-access");

      // Once the runtime finally answers, the barrier clears and the very next
      // wake-up recovers the thread for real.
      //
      // NOT for a HUNG teardown, though: `SessionActor.disconnect()` is
      // single-flight over a promise that never settles, so no retry in this
      // process can ever confirm it. That is why the barrier is held until a
      // restart and why `/end` says so — a third wake-up must keep refusing
      // rather than quietly deciding the runtime is probably fine by now.
      copilot.setHanging(false);
      await fireRetry(app, jobs);
      expect(copilot.resumes).toEqual(["sess-again"]);
      expect(sessionsOf(app).size).toBe(0);
      expect(obligationHandle(app, "t-again")).toBe(retained);
      expect(store.get("t-again")?.state).toBe("active"); // never terminalized
      expect(store.get("t-again")?.reason).toBe("thread-no-access");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("keeps the FIRST barrier if a discard ever races a second one", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-keepfirst", sessionId: "sess-keepfirst" }));
      store.commit("t-keepfirst");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      shrinkTeardown(app);
      const rec = store.get("t-keepfirst");
      expect(rec).toBeDefined();
      let firstDisconnects = 0;
      let secondDisconnects = 0;
      const first = {
        disconnect: async (): Promise<void> => {
          firstDisconnects++;
          return new Promise<void>(() => {});
        },
      };
      const second = {
        disconnect: async (): Promise<void> => {
          secondDisconnects++;
        },
      };
      // The obligation must run under a scope, which is where a real discard
      // lives; the coordinator's first-wins rule is what is under test.
      const discard = (actor: unknown): Promise<unknown> =>
        (
          app as unknown as {
            ownership: {
              runExclusive(id: string, body: (s: unknown) => Promise<void>): Promise<unknown>;
            };
          }
        ).ownership.runExclusive("t-keepfirst", async (scope) =>
          (
            app as unknown as {
              discardResumedActor(r: unknown, a: unknown, why: string, o: unknown): Promise<void>;
            }
          ).discardResumedActor(rec, actor, "test", { scope })
        );

      await discard(first);
      const retained = obligationHandle(app, "t-keepfirst");
      expect(retained).toBeDefined();
      expect(firstDisconnects).toBe(1);

      // A newer actor's clean exit does not make an older, unproven one safe.
      await discard(second);
      expect(obligationHandle(app, "t-keepfirst")).toBe(retained); // same registration
      expect(secondDisconnects).toBe(0); // never registered, never attempted
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("claims the thread for the in-thread /end too, not only /end thread:<id>", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-claim", sessionId: "sess-claim" }));
      store.commit("t-claim");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      const claims = { get: (id: string) => (inspectOwnership(app).teardownClaims().includes(id) ? 1 : 0), has: (id: string) => inspectOwnership(app).teardownClaims().includes(id) };
      const seen: Array<number | undefined> = [];
      const interaction = {
        channelId: "t-claim",
        guildId: "g1",
        channel: { isThread: () => true, parentId: "c1" },
        user: { id: "u1" },
        options: { getString: () => null },
        async reply(): Promise<void> {
          seen.push(claims.get("t-claim")); // claimed while the command runs
        },
        async deferReply(): Promise<void> {},
        async editReply(): Promise<void> {},
      };
      await (
        app as unknown as { cmdEnd(i: unknown): Promise<void> }
      ).cmdEnd(interaction);

      expect(seen).toHaveLength(1);
      expect(seen[0] ?? 0).toBeGreaterThanOrEqual(1); // claimed while the command runs
      expect(claims.has("t-claim")).toBe(false); // and fully released afterwards
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("arms the retry loop in onReady, immediately after the phase gate opens", () => {
    // No behavioural test can reach `onReady` without a real gateway and a REST
    // command registration, and an unarmed loop in production is precisely the
    // defect this whole feature exists to fix — so the wiring is asserted at the
    // source, the way this repo already asserts shipped-script and doc contracts.
    const src = readFileSync(join(process.cwd(), "src", "app.ts"), "utf8");
    const armed = /this\.phase = "ready";\s*(?:\/\/[^\n]*\n\s*)*this\.startAccessRetryLoop\(\);/;
    expect(src).toMatch(armed);
    // And only there: a second arming site would be a second loop.
    expect(src.match(/this\.startAccessRetryLoop\(\)/g)).toHaveLength(1);
  });
});

describe("a retry attempt that outlives shutdown must touch nothing", () => {
  it("persists no terminal transition, and no side effect, after stop() released the lock", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-late", sessionId: "sess-late" }));
      store.commit("t-late");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let lockReleased = false;
      useObservableLock(app, {
        path: "(test)",
        async release(): Promise<void> {
          lockReleased = true;
        },
      });

      let access = false;
      let deleted = false;
      let hold: Promise<void> | undefined;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        if (hold) await hold;
        if (deleted) throw { code: 10003 }; // definitively gone ⇒ terminal
        return visibleThread;
      });

      await reconcileReal(app);
      expect(store.get("t-late")?.reason).toBe("thread-no-access");
      expect(localLeasesOf(app).size).toBe(1);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      // The classification is wedged — a slow/hanging Discord call — so the
      // bounded join in `stop()` cannot succeed.
      let release: () => void = () => {};
      hold = new Promise<void>((r) => {
        release = r;
      });
      useOwnershipBounds(app, { joinTimeoutMs: 10 });
      const fetchesBefore = fetchCalls.length;
      const tick = beginRetry(app, jobs);
      await vi.waitFor(() => expect(fetchCalls.length).toBeGreaterThan(fetchesBefore));

      await app.stop();
      // The attempt did not quiesce, so the lock is deliberately STILL HELD:
      // its in-flight REST/git/runtime work cannot be recalled, and a successor
      // instance must not start reconciling the same records and checkouts.
      expect(lockReleased).toBe(false);

      const bytesAfterStop = readFileSync(f, "utf8");
      const recordAfterStop = JSON.stringify(store.get("t-late"));
      const leasesAfterStop = JSON.stringify([...localLeasesOf(app)]);
      const noticesAfterStop = transport.notices.length;

      // Only NOW does the classification come back — and it says the thread is
      // gone, which on any other day is a terminal transition that rewrites the
      // record, drops the lease and posts a notice. This process no longer owns
      // any of that.
      deleted = true;
      release();
      await tick;

      expect(readFileSync(f, "utf8")).toBe(bytesAfterStop); // byte-for-byte
      expect(JSON.stringify(store.get("t-late"))).toBe(recordAfterStop);
      expect(JSON.stringify([...localLeasesOf(app)])).toBe(leasesAfterStop);
      expect(transport.notices.length).toBe(noticesAfterStop);
      expect(store.get("t-late")?.state).toBe("active"); // still resumable next boot
      expect(store.get("t-late")?.reason).toBe("thread-no-access");
      expect(sessionsOf(app).size).toBe(0);
      // And only now, once nothing of ours can still be working, is ownership
      // of the state directory handed over.
      await vi.waitFor(() => expect(lockReleased).toBe(true));
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("holds the lock through a rebuild that stop() could not join, then releases it", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const wt = wtBind("t-gitlate", { sessionId: "sess-gitlate" });
      store.reserve(wt);
      store.commit("t-gitlate");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let lockReleased = false;
      useObservableLock(app, {
        path: "(test)",
        async release(): Promise<void> {
          lockReleased = true;
        },
      });
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });
      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      useOwnershipBounds(app, { joinTimeoutMs: 10 });
      access = true;

      // `git worktree add` is already running. An epoch cannot recall it, and it
      // will finish writing to disk on its own schedule.
      let entered: () => void = () => {};
      const inRebuild = new Promise<void>((r) => {
        entered = r;
      });
      let releaseRebuild: () => void = () => {};
      const held = new Promise<void>((r) => {
        releaseRebuild = r;
      });
      worktreeHooks.add = async (_repo, dir) => {
        entered();
        await held;
        mkdirSync(dir, { recursive: true });
      };
      worktreeHooks.remove = async (_repo, dir) => {
        rmSync(dir, { recursive: true, force: true });
        return "removed";
      };
      rmSync(wt.workDir, { recursive: true, force: true });

      const tick = beginRetry(app, jobs);
      await inRebuild;
      await app.stop();
      expect(lockReleased).toBe(false); // git is still writing under our root

      releaseRebuild();
      await tick;

      expect(store.get("t-gitlate")?.state).toBe("active");
      expect(store.get("t-gitlate")?.reason).toBe("thread-no-access");
      expect(sessionsOf(app).size).toBe(0);
      await vi.waitFor(() => expect(lockReleased).toBe(true));
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("never releases the lock while an attempt never settles at all", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-never", sessionId: "sess-never" }));
      store.commit("t-never");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        transport,
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let lockReleased = false;
      useObservableLock(app, {
        path: "(test)",
        async release(): Promise<void> {
          lockReleased = true;
        },
      });
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        await new Promise<void>(() => {}); // never comes back
        return visibleThread;
      });
      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      useOwnershipBounds(app, { joinTimeoutMs: 10 });
      access = true;

      const fetchesBefore = fetchCalls.length;
      beginRetry(app, jobs);
      await vi.waitFor(() => expect(fetchCalls.length).toBeGreaterThan(fetchesBefore));

      const bytes = readFileSync(f, "utf8");
      await app.stop();
      expect(lockReleased).toBe(false);

      // Give it every chance to release late. It must not: the PID lock stays
      // for the life of this process, and a successor reclaims it as stale
      // once this pid is gone (see `acquireSingleInstanceLock`).
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
      expect(lockReleased).toBe(false);
      expect(readFileSync(f, "utf8")).toBe(bytes);
      expect(sessionsOf(app).size).toBe(0);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

describe("shutdown ownership: single-flight, no forced exit, no leaked capability", () => {
  it("runs stop() exactly once no matter how many callers ask", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let releases = 0;
      let releasing: (() => void) | undefined;
      useObservableLock(app, {
        path: "(test)",
        async release(): Promise<void> {
          releases++;
          // Hold the FIRST stop open, so the second caller genuinely overlaps it.
          await new Promise<void>((r) => {
            releasing = r;
          });
        },
      });

      const first = app.stop();
      const second = app.stop();
      const third = app.stop();
      await vi.waitFor(() => expect(releasing).toBeDefined());
      releasing?.();
      await Promise.all([first, second, third]);

      // A second SIGINT/SIGTERM (or a bootstrap catch racing a signal) must JOIN
      // the teardown, not return early from a half-finished one.
      expect(releases).toBe(1);
      expect(second).toBe(first);
      expect(third).toBe(first);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("a termination signal stops once and sets an exit code instead of forcing exit", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    const previousExitCode = process.exitCode;
    try {
      const store = new SessionStore(f);
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let releases = 0;
      useObservableLock(app, {
        path: "(test)",
        async release(): Promise<void> {
          releases++;
        },
      });
      process.exitCode = undefined;

      const onSignal = (app as unknown as {
        onTerminationSignal(sig: string): Promise<void>;
      }).onTerminationSignal.bind(app);
      await Promise.all([onSignal("SIGINT"), onSignal("SIGTERM")]);

      expect(releases).toBe(1);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("reports a failed shutdown honestly instead of claiming success", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    const previousExitCode = process.exitCode;
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    try {
      const store = new SessionStore(f);
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      useObservableLock(app, {
        path: "(test)",
        release: async () => {
          throw new Error("lock file vanished");
        },
      });
      // `lock.release()` is already `.catch()`ed inside stop(); force the failure
      // through a path that is not, so the signal handler's error branch is real.
      (app as unknown as { clearAccessRetryTimer(): void }).clearAccessRetryTimer = () => {
        throw new Error("teardown exploded");
      };
      process.exitCode = undefined;

      await (app as unknown as { onTerminationSignal(sig: string): Promise<void> }).onTerminationSignal(
        "SIGTERM"
      );

      expect(process.exitCode).toBe(1); // not a quiet exit 0
      expect(JSON.stringify(errors)).toContain("teardown exploded");
    } finally {
      spy.mockRestore();
      process.exitCode = previousExitCode;
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("does not force process.exit from the signal path", () => {
    // A forced exit truncates the very things shutdown just went to the trouble
    // of arranging: a git/runtime child still running under this pid, and the
    // deferred lock release that waits for it. Asserted at the source because a
    // real `process.exit` cannot be observed from inside the process it kills.
    const src = readFileSync(join(process.cwd(), "src", "app.ts"), "utf8");
    const signalSection = src.slice(
      src.indexOf("private installSignalHandlers"),
      src.indexOf("private async stopOnce(")
    );
    expect(signalSection.length).toBeGreaterThan(0);
    expect(signalSection).not.toMatch(/process\.exit\s*\(/);
    expect(signalSection).toContain("process.exitCode");
  });

  it("closes a captured root that cancellation stops from reaching an actor", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-root", sessionId: "sess-root" }));
      store.commit("t-root");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot(),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let closes = 0;
      const trustedRoot = {
        validationPath: REPO,
        finalPath: REPO,
        close: async (): Promise<void> => {
          closes++;
        },
      };
      (app as unknown as {
        captureValidatedRoot(b: unknown): Promise<unknown>;
      }).captureValidatedRoot = async () => {
        // The capability is open from here on; nothing but a transfer to an
        // actor, or a close, may end this method.
        (app as unknown as { shuttingDown: boolean }).shuttingDown = true;
        return { ok: true, trustedRoot, binding: bind({ threadId: "t-root" }), approvalKey: REPO };
      };

      const rec = store.get("t-root");
      await (app as unknown as { resumeRecord(r: unknown, o?: unknown): Promise<void> }).resumeRecord(rec);

      expect(closes).toBe(1); // released, not leaked
      expect(sessionsOf(app).has("t-root")).toBe(false);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("closes a captured root when the resume itself fails", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-root2", sessionId: "sess-root2" }));
      store.commit("t-root2");
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        fakeCopilot({ resumeError: "getaddrinfo ENOTFOUND api.githubcopilot.com" }),
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      let closes = 0;
      const trustedRoot = {
        validationPath: REPO,
        finalPath: REPO,
        close: async (): Promise<void> => {
          closes++;
        },
      };
      (app as unknown as {
        captureValidatedRoot(b: unknown): Promise<unknown>;
      }).captureValidatedRoot = async () => ({
        ok: true,
        trustedRoot,
        binding: bind({ threadId: "t-root2" }),
        approvalKey: REPO,
      });

      const rec = store.get("t-root2");
      await (app as unknown as { resumeRecord(r: unknown, o?: unknown): Promise<void> }).resumeRecord(rec);

      expect(closes).toBe(1); // no actor took it over, so it must be closed
      expect(sessionsOf(app).has("t-root2")).toBe(false);
      expect(store.get("t-root2")?.state).toBe("active"); // transient ⇒ retried later
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

describe("the phase gate closes before the teardown, not after it", () => {
  it("admits nothing from the instant stop() is asked for, while teardown runs", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-gate", sessionId: "sess-gate" }));
      store.commit("t-gate");
      let releaseTeardown: () => void = () => {};
      const held = new Promise<void>((r) => {
        releaseTeardown = r;
      });
      // `copilot.stop()` is the last thing `teardownResources` awaits, and in
      // production it is an RPC that can take a while. Holding it open is how a
      // test stands inside the teardown.
      const copilot = {
        createSession: async () => fakeSession,
        resumeSession: async () => fakeSession,
        stop: async () => {
          await held;
        },
      } as unknown as CopilotClient;
      const app = DiscordCopilotApp.createForTest(
        cfg,
        REPOS_ROOT,
        copilot,
        new FakeTransport(),
        store,
        new ChannelRegistry("c1", "g1", registryFile)
      );
      (app as unknown as { phase: string }).phase = "ready";

      const stopping = app.stop();

      // Synchronously, before a single await of the teardown: the bot is no
      // longer ready, so `onInteraction`'s gate refuses every command, and the
      // coordinator declines to admit any new owned work.
      expect((app as unknown as { phase: string }).phase).toBe("shuttingDown");
      const admitted = await (
        app as unknown as {
          ownership: { runExclusive(id: string, b: () => Promise<void>): Promise<{ ran: boolean }> };
        }
      ).ownership.runExclusive("t-gate", async () => {});
      expect(admitted.ran).toBe(false);

      releaseTeardown();
      await stopping;
      expect((app as unknown as { phase: string }).phase).toBe("shuttingDown");
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("closes that gate for a post-construction startup failure too", async () => {
    // `DiscordCopilotApp.start` fails after the app exists ⇒ it must go through
    // `app.stop()`, which closes the gate, rather than straight to the
    // coordinator, which would tear the app down underneath a bot that still
    // believed it was ready.
    const src = readFileSync(join(process.cwd(), "src", "app.ts"), "utf8");
    const startCatch = src.slice(src.indexOf("static async start("), src.indexOf("private assertChannelRegistryUsable"));
    expect(startCatch).toMatch(/if \(app\) await app\.stop\(\)/);
    expect(startCatch).toMatch(/else await ownership\.shutdown\(\)/);
  });
});

describe("a rebind is a teardown claim on its thread", () => {
  /** Drive the claim the way `applyRebind` does, without building a real rebind
   *  transaction: the claim, not the git work, is what is under test here. */
  function ownershipOf(app: DiscordCopilotApp): {
    runTeardown(id: string, body: (s: unknown) => Promise<unknown>): Promise<unknown>;
    runExclusive(id: string, body: (s: unknown) => Promise<unknown>): Promise<{ ran: boolean }>;
    shutdown(): Promise<void>;
  } {
    return (app as unknown as { ownership: ReturnType<typeof ownershipOf> }).ownership;
  }

  function appWith(f: string, registryFile: string, store: SessionStore): DiscordCopilotApp {
    return DiscordCopilotApp.createForTest(
      cfg,
      REPOS_ROOT,
      fakeCopilot(),
      new FakeTransport(),
      store,
      new ChannelRegistry("c1", "g1", registryFile)
    );
  }

  it("declines a concurrent access retry for the thread it is rebinding", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      store.reserve(bind({ threadId: "t-rb", sessionId: "sess-rb" }));
      store.commit("t-rb");
      const app = appWith(f, registryFile, store);
      let access = false;
      setChannelFetch(app, async () => {
        if (!access) throw { code: 50001 };
        return visibleThread;
      });
      await reconcileReal(app);
      const jobs = installFakeScheduler(app);
      readyAndStartRetry(app);
      access = true;

      let admitted: { ran: boolean } | undefined;
      let other: { ran: boolean } | undefined;
      await ownershipOf(app).runTeardown("t-rb", async () => {
        // A rebind is mid-transaction. A retry resuming into this thread now is
        // the same hazard `/end` already guards against.
        admitted = await ownershipOf(app).runExclusive("t-rb", async () => undefined);
        other = await ownershipOf(app).runExclusive("t-other", async () => undefined);
      });

      expect(admitted?.ran).toBe(false);
      expect(other?.ran).toBe(true); // and only that thread
      // Released with the transaction, so the loop works again.
      await fireRetry(app, jobs);
      expect(sessionsOf(app).has("t-rb")).toBe(true);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("keeps the lock until a detached incarnation is discharged, across shutdown", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const app = appWith(f, registryFile, store);
      let released = 0;
      useObservableLock(app, {
        path: "(test)",
        release: async () => {
          released++;
        },
      });
      let confirmable = false;
      await ownershipOf(app).runTeardown("t-stale", async (scope) => {
        (scope as { retain(k: string, o: unknown): unknown }).retain(
          "stale-rebind:t-stale:s1:1",
          {
            describe: () => "a detached rebind incarnation s1",
            attempt: async () => confirmable,
          }
        );
      });
      expect(inspectOwnership(app).obligationKeys()).toEqual(["stale-rebind:t-stale:s1:1"]);

      await app.stop();
      // The runtime was never proved stopped, so the checkout it may still hold
      // must not be handed to a successor instance.
      expect(released).toBe(0);
      expect(inspectOwnership(app).obligationKeys()).toEqual(["stale-rebind:t-stale:s1:1"]);

      confirmable = true;
      await (
        inspectOwnership(app).obligation("stale-rebind:t-stale:s1:1") as
          | { attempt(): Promise<boolean> }
          | undefined
      )?.attempt();
      await vi.waitFor(() => expect(released).toBe(1));
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("releases overlapping rebind and /end claims independently", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const app = appWith(f, registryFile, store);
      const seen: string[][] = [];

      await ownershipOf(app).runTeardown("t-ov", async () => {
        seen.push(inspectOwnership(app).teardownClaims());
        // A nested `/end` inside a rebind is a counted claim, not a second one.
        await ownershipOf(app).runTeardown("t-ov", async () => {
          seen.push(inspectOwnership(app).teardownClaims());
        });
        // The inner claim released; the outer one still stands.
        seen.push(inspectOwnership(app).teardownClaims());
        const admitted = await ownershipOf(app).runExclusive("t-ov", async () => undefined);
        expect(admitted.ran).toBe(false);
      });

      expect(seen).toEqual([["t-ov"], ["t-ov"], ["t-ov"]]);
      expect(inspectOwnership(app).teardownClaims()).toEqual([]);
      const after = await ownershipOf(app).runExclusive("t-ov", async () => undefined);
      expect(after.ran).toBe(true);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("does not leak a claim when the teardown body rejects", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      const app = appWith(f, registryFile, store);

      await expect(
        ownershipOf(app).runTeardown("t-boom", async () => {
          throw new Error("rebind exploded mid-transaction");
        })
      ).rejects.toThrow(/rebind exploded/);

      // A leaked claim would silently take this thread out of the retry loop for
      // the life of the process.
      expect(inspectOwnership(app).teardownClaims()).toEqual([]);
      const admitted = await ownershipOf(app).runExclusive("t-boom", async () => undefined);
      expect(admitted.ran).toBe(true);
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

describe("nothing this process started may be dropped unnoticed at shutdown", () => {
  /** Every runtime the app still indexes must have a matching ownership
   *  obligation. This is the invariant the two blockers broke in different
   *  places: the app kept its own reference while the coordinator learned
   *  nothing, so the lock was released over a runtime that might still be live. */
  function assertEveryRetainedRuntimeIsOwed(app: DiscordCopilotApp): void {
    const keys = inspectOwnership(app).obligationKeys();
    const stale = (
      app as unknown as {
        staleRebindActors: Map<unknown, { binding: SessionBinding & { generation: number } }>;
      }
    ).staleRebindActors;
    for (const entry of stale.values()) {
      const key = `stale-rebind:${entry.binding.threadId}:${entry.binding.sessionId}:${entry.binding.generation}`;
      expect(keys, `retained stale incarnation ${entry.binding.sessionId} is not owed`).toContain(key);
    }
  }

  function liveSessionApp(
    store: SessionStore,
    registryFile: string,
    disconnect: () => Promise<void>
  ): { app: DiscordCopilotApp; releases: () => number } {
    const app = DiscordCopilotApp.createForTest(
      cfg,
      REPOS_ROOT,
      fakeCopilot(),
      new FakeTransport(),
      store,
      new ChannelRegistry("c1", "g1", registryFile)
    );
    let released = 0;
    useObservableLock(app, {
      path: "(test)",
      release: async () => {
        released++;
      },
    });
    // A perfectly ordinary live session — the case that had no barrier at all.
    sessionsOf(app).set("t-live", {
      actor: { disconnect },
      broker: { abort: () => {} },
      running: false,
      titled: true,
      titleEpoch: 0,
      queue: [],
      workDir: REPO,
      repoPath: REPO,
      devMode: "local",
      parentChannelId: "c1",
      hasRunTurn: true,
    } as unknown as never);
    return { app, releases: () => released };
  }

  it("holds the lock when an ordinary live session's disconnect THROWS", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      let confirmable = false;
      const { app, releases } = liveSessionApp(new SessionStore(f), registryFile, async () => {
        if (!confirmable) throw new Error("runtime refused to close");
      });

      await app.stop();

      expect(releases()).toBe(0);
      expect(hasRuntimeBarrier(app, "t-live")).toBe(true);
      assertEveryRetainedRuntimeIsOwed(app);

      // …and letting go is exactly as hard as proving it stopped.
      confirmable = true;
      await (
        inspectOwnership(app).obligation("runtime:t-live") as { attempt(): Promise<boolean> }
      ).attempt();
      await vi.waitFor(() => expect(releases()).toBe(1));
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });

  it("holds the lock when an ordinary live session's disconnect HANGS", async () => {
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      let finish: () => void = () => {};
      const { app, releases } = liveSessionApp(
        new SessionStore(f),
        registryFile,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      useOwnershipBounds(app, { obligationTimeoutMs: 20, teardownTimeoutMs: 2_000 });

      await app.stop();

      expect(releases()).toBe(0); // a hang proves no more than a throw
      expect(hasRuntimeBarrier(app, "t-live")).toBe(true);
      void finish;
    } finally {
      rmSync(f, { force: true });
      rmSync(registryFile, { force: true });
    }
  });
});

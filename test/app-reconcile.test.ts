import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { DiscordCopilotApp } from "../src/app.js";
import { SessionActor, type SessionActorOpts } from "../src/copilot/session-actor.js";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import { ChannelRegistry } from "../src/core/channel-registry.js";
import type { SecureOpenBackend } from "../src/core/secure-open.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { SendFileResult, Transport } from "../src/core/transport.js";
import { tmpdir } from "node:os";
import { stateDir } from "../src/core/paths.js";
import { join } from "node:path";
import { existsSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";

// The app owns durable state beneath os.homedir(). Redirect it before any
// fixture calls stateDir(), so this suite never reads a developer's registry
// or leaves worktrees in their real home directory.
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const fakeHome = mkdtempSync(join(tmpdir(), "dp-reconcile-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

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
  for (const d of wtDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  rmSync(fakeHome, { recursive: true, force: true });
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
    new ChannelRegistry("c1", "g1", join(fakeHome, "production-style-channels.json"))
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
    // and absolute paths: 15 realistic entries measure ~2250 chars, so the last
    // ids AND the instruction line were silently dropped — in a message whose
    // entire job is to name ids.
    const f = tmpFile();
    const registryFile = `${f}.channels.json`;
    try {
      const store = new SessionStore(f);
      for (const parentChannelId of ["c1", "c2"]) {
        for (let i = 0; i < 40; i++) {
          const id = `${parentChannelId}-153200000000000${String(i).padStart(4, "0")}`;
          store.reserve(
            bind({
              threadId: id,
              parentChannelId,
              workDir: join(`${stateDir()}-worktrees`, id),
              branch: `copilot/t-${id}`,
            })
          );
          store.commit(id);
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

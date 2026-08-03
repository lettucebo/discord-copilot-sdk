import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { DiscordCopilotApp } from "../src/app.js";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Transport } from "../src/core/transport.js";
import { tmpdir } from "node:os";
import { stateDir } from "../src/core/paths.js";
import { join } from "node:path";
import { rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";

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

const cfg = {
  DISCORD_BOT_TOKEN: "t",
  DISCORD_ALLOWED_USER_IDS: ["u1"],
  DISCORD_GUILD_ID: "g1",
  DISCORD_PARENT_CHANNEL_ID: "c1",
  REPOS_ROOT: REPOS_ROOT,
  DEFAULT_MODEL: "claude-sonnet-5",
  DEFAULT_CONTEXT_TIER: "default",
  PERMISSION_POLICY: "ask",
} as unknown as Parameters<typeof DiscordCopilotApp.createForTest>[0];

class FakeTransport implements Transport {
  notices: string[] = [];
  async render(): Promise<void> {}
  async showPermission(): Promise<void> {}
  async showUserInput(): Promise<void> {}
  async showPlan(): Promise<void> {}
  async notice(_k: string, t: string): Promise<void> {
    this.notices.push(t);
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

function sessionsOf(app: DiscordCopilotApp): Map<string, unknown> {
  return (app as unknown as { sessions: Map<string, unknown> }).sessions;
}
function reconcile(app: DiscordCopilotApp, classify: () => Promise<string>): Promise<void> {
  return (app as unknown as {
    reconcileOnStartup(d?: {
      classifyThread?: (id: string) => Promise<string>;
      validateBinding?: () => Promise<{ ok: true }>;
    }): Promise<void>;
  }).reconcileOnStartup({
    classifyThread: classify,
    // These fixtures use paths that do not exist on disk: they exercise the
    // reconcile STATE MACHINE, not the git-backed ownership proof (which has its
    // own suite in binding.test.ts, against real worktrees). Injecting a
    // pass-through keeps the two concerns from smearing into each other.
    validateBinding: async () => ({ ok: true }),
  });
}

describe("reconcileOnStartup (app-level wiring, P2)", () => {
  it("active + valid thread → resumes, registers, keeps active, posts recovery notice", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      await reconcile(app, async () => "valid");
      expect(sessionsOf(app).has("t1")).toBe(true);
      expect(store.get("t1")?.state).toBe("active");
      expect(transport.notices.some((n) => n.includes("復原"))).toBe(true);
    } finally {
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
    override async notice(k: string, t: string): Promise<void> {
      this.sent.push({ key: k, text: t });
    }
  }

  // announceUnreachableRecords() ALSO reports "stray" worktree directories by
  // reading worktreeRoot() (= `${stateDir()}-worktrees`) off the real disk, and
  // stateDir() resolves through os.homedir(). Without redirecting HOME these
  // tests read the DEVELOPER'S OWN worktree root: run the bot once, leave a
  // session's checkout behind, and "stays silent when nothing is unreachable"
  // starts failing on that machine only — a test whose verdict depends on
  // whether you have ever used the app. os.homedir() reads $HOME/%USERPROFILE%
  // on every call, so pointing them at an empty temp dir is enough.
  let realHome: string | undefined;
  let realUserProfile: string | undefined;
  let fakeHome: string;
  beforeAll(() => {
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    fakeHome = mkdtempSync(join(tmpdir(), "dp-reconcile-home-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    rmSync(fakeHome, { recursive: true, force: true });
  });

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
});

describe("a record retired by reclaim stays announceable", () => {
  // reclaim() retires a kept-worktree record via setState(..., "blocked", reason),
  // and setState OVERWRITES reason. If that erases `thread-gone`, the record drops
  // out of the startup announcement (which keys on the thread-* reasons) AND out
  // of the stray-directory list (which excludes any dir a record mentions) — so
  // the one leftover whose thread you cannot type into goes silent for ever.
  class KeyedTransport2 extends FakeTransport {
    sent: Array<{ key: string; text: string }> = [];
    override async notice(k: string, t: string): Promise<void> {
      this.sent.push({ key: k, text: t });
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
    override async notice(_k: string, t: string): Promise<void> {
      this.sent.push(t);
    }
  }
  it("never composes past notice()'s 1900-char slice, and says how many it left out", async () => {
    // A fixed count cap does not bound a message built from 19-digit snowflakes
    // and absolute paths: 15 realistic entries measure ~2250 chars, so the last
    // ids AND the instruction line were silently dropped — in a message whose
    // entire job is to name ids.
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      for (let i = 0; i < 40; i++) {
        const id = `153200000000000${String(i).padStart(4, "0")}`;
        store.reserve(
          bind({ threadId: id, workDir: join(`${stateDir()}-worktrees`, id), branch: `copilot/t-${id}` })
        );
        store.commit(id);
        store.setState(id, "blocked", "thread-gone");
      }
      const transport = new Cap();
      const app = DiscordCopilotApp.createForTest(cfg, REPOS_ROOT, fakeCopilot(), transport, store);
      await (app as unknown as { announceUnreachableRecords(): Promise<void> }).announceUnreachableRecords();
      expect(transport.sent).toHaveLength(1);
      const msg = transport.sent[0]!;
      expect(msg.length).toBeLessThanOrEqual(1900);
      expect(msg).toContain("另有"); // admits what it omitted
      expect(msg).toContain("/end thread:"); // the instruction survives the cut
    } finally {
      rmSync(f, { force: true });
    }
  });
});

import { describe, it, expect } from "vitest";
import { DiscordCopilotApp } from "../src/app.js";
import { SessionStore, type SessionBinding } from "../src/core/session-store.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Transport } from "../src/core/transport.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";

const REPO = "C:\\repo";
const tmpFile = (): string => join(tmpdir(), `dp-reconcile-${Math.random()}.json`);

const bind = (over: Partial<SessionBinding> = {}): SessionBinding => ({
  threadId: "t1",
  sessionId: "sess-1",
  generation: 1,
  repoPath: REPO,
  guildId: "g1",
  parentChannelId: "c1",
  workDir: REPO,
  ...over,
});

const cfg = {
  DISCORD_BOT_TOKEN: "t",
  DISCORD_ALLOWED_USER_IDS: ["u1"],
  DISCORD_GUILD_ID: "g1",
  DISCORD_PARENT_CHANNEL_ID: "c1",
  CONTROLLED_REPO_PATH: REPO,
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

function fakeCopilot(opts: { resumeError?: string } = {}): CopilotClient {
  return {
    createSession: async () => fakeSession,
    resumeSession: async (_id: string, _cfg: unknown) => {
      if (opts.resumeError) throw new Error(opts.resumeError);
      return fakeSession;
    },
  } as unknown as CopilotClient;
}

function sessionsOf(app: DiscordCopilotApp): Map<string, unknown> {
  return (app as unknown as { sessions: Map<string, unknown> }).sessions;
}
function reconcile(app: DiscordCopilotApp, classify: () => Promise<string>): Promise<void> {
  return (app as unknown as {
    reconcileOnStartup(d?: { classifyThread?: (id: string) => Promise<string> }): Promise<void>;
  }).reconcileOnStartup({ classifyThread: classify });
}

describe("reconcileOnStartup (app-level wiring, P2)", () => {
  it("active + valid thread → resumes, registers, keeps active, posts recovery notice", async () => {
    const f = tmpFile();
    try {
      const store = new SessionStore(f);
      store.reserve(bind()); store.commit("t1");
      const transport = new FakeTransport();
      const app = DiscordCopilotApp.createForTest(cfg, REPO, fakeCopilot(), transport, store);
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
      const app = DiscordCopilotApp.createForTest(cfg, REPO, fakeCopilot({ resumeError: "session not found" }), transport, store);
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
        REPO,
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
      const app = DiscordCopilotApp.createForTest(cfg, REPO, client, new FakeTransport(), store);
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
      store.reserve(bind({ repoPath: "C:\\different-repo" })); store.commit("t1");
      const app = DiscordCopilotApp.createForTest(cfg, REPO, fakeCopilot(), new FakeTransport(), store);
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
      const app = DiscordCopilotApp.createForTest(cfg, REPO, fakeCopilot(), new FakeTransport(), store);
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
      const app = DiscordCopilotApp.createForTest(cfg, REPO, fakeCopilot(), new FakeTransport(), store);
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
      const app = DiscordCopilotApp.createForTest(cfg, REPO, fakeCopilot(), new FakeTransport(), store);
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
      const app = DiscordCopilotApp.createForTest(cfg, REPO, fakeCopilot(), new FakeTransport(), store);
      await expect(reconcile(app, async () => "valid")).rejects.toThrow(/corrupt/i);
    } finally {
      rmSync(f, { force: true });
    }
  });
});

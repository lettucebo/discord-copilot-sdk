import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { DiscordCopilotApp, type Session } from "../src/app.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Transport } from "../src/core/transport.js";
import { PendingInteractionBroker } from "../src/core/broker.js";

/**
 * App-level regression for the /stop-during-download blocker (RubberDuck P5):
 * proves the REAL wiring end to end — a /stop while an attachment is downloading
 * cancels the in-flight fetch and the agent turn is NEVER started, while a normal
 * download still reaches the agent. Uses a local HTTP server (a /hang endpoint
 * that never responds until the socket is destroyed, and a /png endpoint) so the
 * fetch inside downloadBounded is genuinely in flight when we abort.
 */

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 1x1 PNG (real bytes) so downloadBounded returns a usable image buffer.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

class FakeActor {
  runTurnCalls: Array<{ prompt: string; images: number }> = [];
  stopCalls = 0;
  disconnectCalls = 0;
  isFaulted(): boolean {
    return false;
  }
  async runTurn(prompt: string, _watchdog?: number, images: unknown[] = []): Promise<void> {
    this.runTurnCalls.push({ prompt, images: images.length });
  }
  async stop(): Promise<boolean> {
    this.stopCalls++;
    return true;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls++;
  }
}

class FakeTransport implements Transport {
  notices: string[] = [];
  async render(): Promise<void> {}
  async sendFile(): Promise<{ ok: true } | { ok: false; reason: "no-attach-permission" | "too-large" | "blocked" | "unavailable" | "transient" }> {
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

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_1x1.length) });
      res.end(PNG_1x1);
    }
    // /hang: never respond — the socket stays open until the fetch is aborted or
    // the server is torn down. This is our "download in flight" window.
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

const cfg = {
  DISCORD_BOT_TOKEN: "t",
  DISCORD_ALLOWED_USER_IDS: ["u1"],
  DISCORD_GUILD_ID: "g1",
  DISCORD_PARENT_CHANNEL_ID: "c1",
  REPOS_ROOT: "C:\\Repos",
  DEFAULT_MODEL: "claude-sonnet-5",
  DEFAULT_CONTEXT_TIER: "default",
  PERMISSION_POLICY: "ask",
} as unknown as Parameters<typeof DiscordCopilotApp.createForTest>[0];

const fakeCopilot = {
  // `stop()` is exercised by the shutdown test; the fake must offer it or the
  // assertion fails on the fixture rather than on the behaviour under test.
  stop: async () => {},
} as unknown as CopilotClient;

function imageMessage(url: string): unknown {
  const att = { contentType: "image/png", size: PNG_1x1.length, url, name: "x.png" };
  return { channelId: "thread-1", attachments: new Map([["a", att]]) };
}

function buildAppWithSession(): { app: DiscordCopilotApp; actor: FakeActor; transport: FakeTransport; session: Session } {
  const transport = new FakeTransport();
  const app = DiscordCopilotApp.createForTest(cfg, "C:\\Repos", fakeCopilot, transport);
  const actor = new FakeActor();
  // Typed on purpose: a `Record<string, unknown>` fixture silently drifts from
  // the real Session shape and fails at runtime instead of at typecheck.
  const session: Session = {
    actor: actor as unknown as Session["actor"],
    // A REAL broker: `stop()` aborts every session's pending interactions, so a
    // `{}` stand-in turns a teardown assertion into a TypeError about the fixture.
    broker: new PendingInteractionBroker(),
    running: false,
    titled: true,
    titleEpoch: 0,
    queue: [],
    workDir: "C:\\Repos\\repo",
    repoPath: "C:\\Repos\\repo",
    devMode: "local",
    parentChannelId: "c1",
    hasRunTurn: false,
  };
  (app as unknown as { sessions: Map<string, unknown> }).sessions.set("thread-1", session);
  return { app, actor, transport, session };
}

describe("/stop during image download (app-level wiring)", () => {
  it("cancels the in-flight download and NEVER starts the agent turn", async () => {
    const { app, actor, transport, session } = buildAppWithSession();
    const runTurn = (app as unknown as {
      runTurn(t: string, text: string, m?: unknown): Promise<void>;
    }).runTurn.bind(app);
    const stopSession = (app as unknown as {
      stopSession(s: unknown): Promise<boolean>;
    }).stopSession.bind(app);

    const p = runTurn("thread-1", "幫我看這張圖", imageMessage(`${base}/hang`)); // has TEXT + hanging image
    await tick(); // let the fetch get in flight and currentAbort be installed
    expect(session.currentAbort).toBeInstanceOf(AbortController);

    await stopSession(session); // the real /stop core: abort + actor.stop()
    await p;

    // The turn had non-empty text, so ONLY the abort gate can prevent the send.
    // (A broken gate would call runTurn with the text + empty images.)
    expect(actor.runTurnCalls.length).toBe(0); // agent turn NEVER started
    expect(actor.stopCalls).toBe(1); // /stop reached the actor
    expect(transport.notices.some((n) => n.includes("取消"))).toBe(true);
    expect(session.running).toBe(false); // running cleared
    expect(session.currentAbort).toBeUndefined(); // controller cleared
  });

  it("starts the agent turn normally when NOT stopped", async () => {
    const { app, actor } = buildAppWithSession();
    const runTurn = (app as unknown as {
      runTurn(t: string, text: string, m?: unknown): Promise<void>;
    }).runTurn.bind(app);

    await runTurn("thread-1", "", imageMessage(`${base}/png`)); // downloads fine

    expect(actor.runTurnCalls.length).toBe(1);
    expect(actor.runTurnCalls[0]?.images).toBe(1); // the image was attached
  });

  it("shutdown during a download aborts it and never starts the turn", async () => {
    // Previously exercised through `endAllSessions`, which existed only for the
    // shared-checkout mode where `/new` had to end the previous session. Per-thread
    // dev modes removed that path; `stop()` is now the only bulk teardown, and it
    // must keep the same property: a turn still downloading its attachment is
    // aborted, never sent.
    const { app, actor } = buildAppWithSession();
    const runTurn = (app as unknown as {
      runTurn(t: string, text: string, m?: unknown): Promise<void>;
    }).runTurn.bind(app);

    const p = runTurn("thread-1", "分析這張圖", imageMessage(`${base}/hang`));
    await tick();
    await app.stop();
    await p;

    expect(actor.runTurnCalls.length).toBe(0); // no send-after-teardown
    expect(actor.disconnectCalls).toBe(1); // teardown disconnected the actor
  });
});

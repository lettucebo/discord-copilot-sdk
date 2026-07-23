import { describe, it, expect } from "vitest";
import { SessionActor } from "../src/copilot/session-actor.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Decision, PermissionView, Transport } from "../src/core/transport.js";
import type { RenderState } from "../src/core/turn-render.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeSession {
  handlers = new Map<string, (e: unknown) => void>();
  sent: string[] = [];
  aborted = 0;
  disconnected = 0;
  on(ev: string, h: (e: unknown) => void): void {
    this.handlers.set(ev, h);
  }
  emit(ev: string, e: unknown): void {
    this.handlers.get(ev)?.(e);
  }
  async send(o: { prompt: string }): Promise<void> {
    this.sent.push(o.prompt);
  }
  async abort(): Promise<void> {
    this.aborted++;
    this.emit("session.idle", {}); // aborting makes the session go idle
  }
  async disconnect(): Promise<void> {
    this.disconnected++;
  }
}

class FakeTransport implements Transport {
  renders: RenderState[] = [];
  permissions: PermissionView[] = [];
  notices: string[] = [];
  decision?: (nonce: string, decision: Decision, userId: string) => void;
  async render(_k: string, s: RenderState): Promise<void> {
    this.renders.push(s);
  }
  async flush(): Promise<void> {}
  resetTurn(): void {}
  dispose(): void {}
  async showPermission(v: PermissionView): Promise<void> {
    this.permissions.push(v);
  }
  async notice(_k: string, t: string): Promise<void> {
    this.notices.push(t);
  }
  onDecision(h: (nonce: string, decision: Decision, userId: string) => void): () => void {
    this.decision = h;
    return () => {
      this.decision = undefined;
    };
  }
}

interface Setup {
  actor: SessionActor;
  session: FakeSession;
  transport: FakeTransport;
  broker: PendingInteractionBroker;
  policy: ApprovalPolicy;
  config: Record<string, unknown>;
}

async function setup(): Promise<Setup> {
  const session = new FakeSession();
  const transport = new FakeTransport();
  const broker = new PendingInteractionBroker();
  const policy = new ApprovalPolicy(join(tmpdir(), `discopilot-test-approvals-${Math.random()}.json`));
  let config: Record<string, unknown> = {};
  const client = {
    createSession: async (cfg: Record<string, unknown>) => {
      config = cfg;
      return session;
    },
  } as unknown as CopilotClient;
  const actor = await SessionActor.create(client, {
    sessionKey: "t",
    workingDirectory: "C:\\repo",
    broker,
    transport,
    policy,
  });
  return { actor, session, transport, broker, policy, config };
}

// The captured permission callback (typed loosely for the test).
const perm = (s: Setup): ((r: unknown) => Promise<unknown>) =>
  s.config["onPermissionRequest"] as (r: unknown) => Promise<unknown>;

describe("SessionActor config hardening", () => {
  it("disables file hooks + sets working directory + streaming + all callbacks", async () => {
    const s = await setup();
    expect(s.config["enableFileHooks"]).toBe(false);
    expect(s.config["enableConfigDiscovery"]).toBe(false);
    expect(s.config["workingDirectory"]).toBe("C:\\repo");
    expect(s.config["streaming"]).toBe(true);
    for (const cb of [
      "onPermissionRequest",
      "onUserInputRequest",
      "onElicitationRequest",
      "onExitPlanModeRequest",
    ]) {
      expect(typeof s.config[cb]).toBe("function");
    }
  });

  it("onUserInputRequest throws (fail-closed decline — no fabricated answer)", async () => {
    const s = await setup();
    await expect((s.config["onUserInputRequest"] as () => Promise<unknown>)()).rejects.toThrow(
      /not available/i
    );
  });
});

describe("SessionActor turn lifecycle", () => {
  it("streams deltas and completes on the real session.idle event", async () => {
    const s = await setup();
    const p = s.actor.runTurn("hello", 5000);
    s.session.emit("assistant.message_delta", { data: { deltaContent: "Hi " } });
    s.session.emit("assistant.message_delta", { data: { deltaContent: "there" } });
    s.session.emit("session.idle", {});
    await p;
    expect(s.session.sent).toEqual(["hello"]);
    expect(s.transport.renders.at(-1)!.assistantText).toBe("Hi there");
  });
});

describe("SessionActor permission handling", () => {
  it("shows a shell card and approves once when the user taps Allow once", async () => {
    const s = await setup();
    const result = perm(s)({ kind: "shell", intention: "branch", fullCommandText: "git branch" });
    await tick();
    const view = s.transport.permissions.at(-1)!;
    expect(view.kind).toBe("shell");
    expect(view.summary).toContain("git branch");
    s.transport.decision!(view.nonce, "once", "u1");
    expect(await result).toEqual({ kind: "approve-once" });
    expect(s.broker.size).toBe(0);
  });

  it("session approval records a rule and auto-approves later matching commands (no card)", async () => {
    const s = await setup();
    const r1 = perm(s)({ kind: "shell", fullCommandText: "git --no-pager status", commands: [{ identifier: "git --no-pager status" }] });
    await tick();
    const view = s.transport.permissions.at(-1)!;
    expect(view.canOfferSession).toBe(true);
    expect(view.scopeCommands).toEqual(["git"]); // discloses the executable, not the full command
    s.transport.decision!(view.nonce, "session", "u1");
    expect(await r1).toEqual({ kind: "approve-once" }); // SDK gets approve-once; discopilot stored the rule
    expect(s.policy.isApproved("t", "C:\\repo", ["git"])).toBe(true);
    // A DIFFERENT git command is now auto-approved WITHOUT a new card.
    const before = s.transport.permissions.length;
    const r2 = await perm(s)({ kind: "shell", fullCommandText: "git log --oneline -5", commands: [{ identifier: "git log --oneline -5" }] });
    expect(r2).toEqual({ kind: "approve-once" });
    expect(s.transport.permissions.length).toBe(before); // no card shown
    expect(s.transport.notices.some((n) => /auto-approved/i.test(n))).toBe(true);
  });

  it("always approval persists an executable rule for the repo", async () => {
    const s = await setup();
    const r = perm(s)({ kind: "shell", fullCommandText: "npm test", commands: [{ identifier: "npm test" }] });
    await tick();
    s.transport.decision!(s.transport.permissions.at(-1)!.nonce, "always", "u1");
    expect(await r).toEqual({ kind: "approve-once" });
    expect(s.policy.repoApprovals("C:\\repo")).toContain("npm");
  });

  it("never auto-approves a non-simple command (shell metachars), even if all executables are trusted", async () => {
    const s = await setup();
    s.policy.approveForSession("t", "git");
    s.policy.approveForSession("t", "rm");
    const r = perm(s)({
      kind: "shell",
      fullCommandText: "git status && rm -rf x",
      commands: [{ identifier: "git status" }, { identifier: "rm -rf x" }],
    });
    await tick();
    expect(s.transport.permissions).toHaveLength(1); // carded despite both trusted (has &&)
    expect(s.transport.permissions.at(-1)!.canOfferSession).toBe(false);
    s.transport.decision!(s.transport.permissions.at(-1)!.nonce, "deny", "u1");
    expect(await r).toEqual({ kind: "denied-interactively-by-user" });
  });

  it("never auto-approves via substitution `$( )` / backticks / pipes", async () => {
    const s = await setup();
    s.policy.approveForSession("t", "git");
    for (const cmd of ["git status $(id)", "git log `id`", "git status | sh"]) {
      const before = s.transport.permissions.length;
      const r = perm(s)({ kind: "shell", fullCommandText: cmd, commands: [{ identifier: cmd }] });
      await tick();
      expect(s.transport.permissions.length).toBe(before + 1); // carded, not auto-approved
      s.transport.decision!(s.transport.permissions.at(-1)!.nonce, "deny", "u");
      await r;
    }
  });

  it("does not offer or auto-approve wrapper/runtime executables (sudo/env/npx/node)", async () => {
    for (const cmd of ["sudo ls", "env X=y ls", "npx cowsay hi", "node app.js"]) {
      const s = await setup();
      s.policy.approveForSession("t", cmd.split(/\s+/)[0]!); // even if (mis)trusted…
      const r = perm(s)({ kind: "shell", fullCommandText: cmd, commands: [{ identifier: cmd }] });
      await tick();
      expect(s.transport.permissions).toHaveLength(1); // …still carded, not auto-approved
      expect(s.transport.permissions.at(-1)!.canOfferSession).toBe(false); // not offerable
      s.transport.decision!(s.transport.permissions.at(-1)!.nonce, "deny", "u");
      await r;
    }
  });

  it("does not offer session/always for a multi-command or empty request", async () => {
    const s = await setup();
    void perm(s)({ kind: "shell", fullCommandText: "git status", commands: [] });
    await tick();
    expect(s.transport.permissions.at(-1)!.canOfferSession).toBe(false);
  });

  it("self-defends: a wider decision on a non-offerable request FAILS CLOSED (deny)", async () => {
    const s = await setup();
    // powershell → wider scope suppressed → canOfferSession false
    const result = perm(s)({
      kind: "shell",
      fullCommandText: "powershell -c whoami",
      commands: [{ identifier: "powershell -c whoami" }],
    });
    await tick();
    expect(s.transport.permissions.at(-1)!.canOfferSession).toBe(false);
    // A "session" decision the request never authorized must deny (not approve).
    s.transport.decision!(s.transport.permissions.at(-1)!.nonce, "session", "u1");
    expect(await result).toEqual({ kind: "denied-interactively-by-user" });
    expect(s.policy.isApproved("t", "C:\\repo", ["powershell"])).toBe(false);
  });

  it("suppresses wider scopes for a generic interpreter (always-allow-powershell footgun)", async () => {
    const s = await setup();
    void perm(s)({
      kind: "shell",
      fullCommandText: "powershell -c whoami",
      commands: [{ identifier: "powershell -c whoami" }],
    });
    await tick();
    expect(s.transport.permissions.at(-1)!.canOfferSession).toBe(false);
  });

  it("denies when the user denies", async () => {
    const s = await setup();
    const result = perm(s)({ kind: "shell", fullCommandText: "rm x" });
    await tick();
    s.transport.decision!(s.transport.permissions.at(-1)!.nonce, "deny", "u1");
    expect(await result).toEqual({ kind: "denied-interactively-by-user" });
  });

  it("auto-denies a non-shell permission (fail closed) with a notice", async () => {
    const s = await setup();
    const result = await perm(s)({ kind: "write", fileName: "a.txt" });
    expect(result).toEqual({ kind: "user-not-available" });
    expect(s.transport.notices.some((n) => /unsupported/i.test(n))).toBe(true);
    expect(s.transport.permissions).toHaveLength(0);
  });

  it("auto-denies a shell command too long to display in full", async () => {
    const s = await setup();
    const result = await perm(s)({ kind: "shell", fullCommandText: "x".repeat(4000) });
    expect(result).toEqual({ kind: "user-not-available" });
    expect(s.transport.notices.some((n) => /too long/i.test(n))).toBe(true);
    expect(s.transport.permissions).toHaveLength(0);
  });

  it("marks a sandbox-bypass request so the card can escalate it", async () => {
    const s = await setup();
    void perm(s)({
      kind: "shell",
      fullCommandText: "sudo rm",
      requestSandboxBypass: true,
      requestSandboxBypassReason: "needs root",
    });
    await tick();
    expect(s.transport.permissions.at(-1)!.summary).toContain("SANDBOX BYPASS");
  });

  it("auto-denies a command containing bidirectional/control characters", async () => {
    const s = await setup();
    const result = await perm(s)({ kind: "shell", fullCommandText: "echo \u202eevil" });
    expect(result).toEqual({ kind: "user-not-available" });
    expect(s.transport.notices.some((n) => /bidirectional|control/i.test(n))).toBe(true);
    expect(s.transport.permissions).toHaveLength(0);
  });

  it("settles deny (no leak) if the approval card cannot be posted", async () => {
    const s = await setup();
    s.transport.showPermission = async () => {
      throw new Error("embed rejected");
    };
    const result = await perm(s)({ kind: "shell", fullCommandText: "ls" });
    expect(result).toEqual({ kind: "user-not-available" });
    expect(s.broker.size).toBe(0);
  });
});

describe("SessionActor abort + teardown", () => {
  it("stop() aborts the SDK turn and clears pending prompts", async () => {
    const s = await setup();
    void perm(s)({ kind: "shell", fullCommandText: "sleep 100" });
    await tick();
    expect(s.broker.size).toBe(1);
    const ok = await s.actor.stop();
    expect(ok).toBe(true);
    expect(s.session.aborted).toBe(1);
    expect(s.broker.size).toBe(0); // pending permission denied by abort
  });

  it("disconnect() unsubscribes the decision handler and disconnects", async () => {
    const s = await setup();
    expect(s.transport.decision).toBeTypeOf("function");
    await s.actor.disconnect();
    expect(s.session.disconnected).toBe(1);
    expect(s.transport.decision).toBeUndefined();
  });

  it("refuses new prompts once closed (lifecycle guard used by the fault path)", async () => {
    const s = await setup();
    await s.actor.disconnect();
    await expect(s.actor.send("hi")).rejects.toThrow(/closed|faulted/);
  });

  it("disconnect() is idempotent (no second runtime disconnect)", async () => {
    const s = await setup();
    await s.actor.disconnect();
    await s.actor.disconnect();
    expect(s.session.disconnected).toBe(1);
  });

  it("a FAILED disconnect faults the actor and never reports success on retry", async () => {
    const s = await setup();
    s.session.disconnect = async () => {
      throw new Error("rpc down");
    };
    await expect(s.actor.disconnect()).rejects.toThrow(/rpc down/);
    expect(s.actor.isFaulted()).toBe(true);
    // The retry must REJECT (fence), not resolve — else /new would delete a
    // session whose runtime may still be live.
    await expect(s.actor.disconnect()).rejects.toThrow(/faulted/);
  });
});

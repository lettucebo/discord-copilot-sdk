import { describe, it, expect } from "vitest";
import { SessionActor } from "../src/copilot/session-actor.js";
import { PendingInteractionBroker } from "../src/core/broker.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import type { CopilotClient } from "@github/copilot-sdk";
import type { Decision, PermissionView, PlanView, Transport, UserInputView } from "../src/core/transport.js";
import type { RenderState } from "../src/core/turn-render.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeSession {
  handlers = new Map<string, (e: unknown) => void>();
  sent: string[] = [];
  setModelCalls: Array<{ model: string; options?: unknown }> = [];
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
  async setModel(model: string, options?: unknown): Promise<void> {
    this.setModelCalls.push({ model, options });
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
  userInputs: UserInputView[] = [];
  plans: PlanView[] = [];
  notices: string[] = [];
  decision?: (nonce: string, decision: Decision, userId: string) => void;
  choice?: (nonce: string, index: number, userId: string) => void;
  plan?: (nonce: string, action: number | "reject", userId: string) => void;
  async render(_k: string, s: RenderState): Promise<void> {
    this.renders.push(s);
  }
  async flush(): Promise<void> {}
  resetTurn(): void {}
  dispose(): void {}
  async showPermission(v: PermissionView): Promise<void> {
    this.permissions.push(v);
  }
  async showUserInput(v: UserInputView): Promise<void> {
    this.userInputs.push(v);
  }
  async showPlan(v: PlanView): Promise<void> {
    this.plans.push(v);
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
  onChoice(h: (nonce: string, index: number, userId: string) => void): () => void {
    this.choice = h;
    return () => {
      this.choice = undefined;
    };
  }
  onPlan(h: (nonce: string, action: number | "reject", userId: string) => void): () => void {
    this.plan = h;
    return () => {
      this.plan = undefined;
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

  it("ask_user: choice button answers (wasFreeform=false), freeform message answers (wasFreeform=true)", async () => {
    const s = await setup();
    const ask = s.config["onUserInputRequest"] as (r: unknown) => Promise<unknown>;
    // choice path
    let result = ask({ question: "Pick one", choices: ["Red", "Blue"], allowFreeform: true });
    await tick();
    expect(s.transport.userInputs.at(-1)!.question).toBe("Pick one");
    expect(s.transport.userInputs.at(-1)!.choices).toEqual(["Red", "Blue"]);
    s.transport.choice!(s.transport.userInputs.at(-1)!.nonce, 1, "u1");
    expect(await result).toEqual({ answer: "Blue", wasFreeform: false });
    // freeform path (via a thread message the app routes through tryConsumeFreeform)
    result = ask({ question: "Name it", choices: [], allowFreeform: true });
    await tick();
    expect(s.actor.tryConsumeFreeform("Fluffy")).toBe(true);
    expect(await result).toEqual({ answer: "Fluffy", wasFreeform: true });
  });

  it("ask_user: an out-of-range choice index is ignored (stays pending)", async () => {
    const s = await setup();
    const ask = s.config["onUserInputRequest"] as (r: unknown) => Promise<unknown>;
    void ask({ question: "Q", choices: ["A"], allowFreeform: false });
    await tick();
    const nonce = s.transport.userInputs.at(-1)!.nonce;
    s.transport.choice!(nonce, 5, "u1"); // invalid
    expect(s.broker.size).toBe(1); // still pending
    s.transport.choice!(nonce, 0, "u1");
    // now settled
    await tick();
    expect(s.broker.size).toBe(0);
  });

  it("exit-plan: an action button approves with selectedAction; Reject declines", async () => {
    const s = await setup();
    const plan = s.config["onExitPlanModeRequest"] as (r: unknown) => Promise<unknown>;
    let result = plan({ summary: "Do it", actions: ["Proceed", "Autopilot"], recommendedAction: "Proceed" });
    await tick();
    expect(s.transport.plans.at(-1)!.actions).toEqual(["Proceed", "Autopilot"]);
    s.transport.plan!(s.transport.plans.at(-1)!.nonce, 1, "u1");
    expect(await result).toEqual({ approved: true, selectedAction: "Autopilot" });
    // reject
    result = plan({ summary: "Do it", actions: ["Proceed"], recommendedAction: "Proceed" });
    await tick();
    s.transport.plan!(s.transport.plans.at(-1)!.nonce, "reject", "u1");
    expect(await result).toEqual({ approved: false, feedback: "Rejected via Discord." });
  });

  it("fails a second ask_user while one is pending (one interactive request at a time)", async () => {
    const s = await setup();
    const ask = s.config["onUserInputRequest"] as (r: unknown) => Promise<unknown>;
    const first = ask({ question: "Q1", choices: ["A"], allowFreeform: true });
    await tick();
    await expect(ask({ question: "Q2", choices: ["B"], allowFreeform: true })).rejects.toThrow(
      /busy|aborting|available/i
    );
    s.transport.choice!(s.transport.userInputs.at(-1)!.nonce, 0, "u1"); // settle the first
    expect(await first).toEqual({ answer: "A", wasFreeform: false });
  });

  it("ask_user THROWS (no fabricated answer) when the card can't be shown", async () => {
    const s = await setup();
    s.transport.showUserInput = async () => {
      throw new Error("no channel");
    };
    await expect(
      (s.config["onUserInputRequest"] as (r: unknown) => Promise<unknown>)({
        question: "Q",
        choices: [],
        allowFreeform: true,
      })
    ).rejects.toThrow(/no response|operator/i);
  });

  it("exit-plan: an invalid action index leaves it pending (never approves blindly)", async () => {
    const s = await setup();
    const plan = s.config["onExitPlanModeRequest"] as (r: unknown) => Promise<unknown>;
    void plan({ summary: "Do it", actions: ["Proceed"], recommendedAction: "Proceed" });
    await tick();
    const nonce = s.transport.plans.at(-1)!.nonce;
    s.transport.plan!(nonce, 9, "u1"); // out of range
    expect(s.broker.size).toBe(1); // still pending (not approved)
    s.transport.plan!(nonce, "reject", "u1");
    await tick();
    expect(s.broker.size).toBe(0);
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

  it("does not offer or auto-approve wrapper/runtime/launcher executables", async () => {
    for (const cmd of ["sudo ls", "env X=y ls", "npx cowsay hi", "node app.js", "find . -name x", "ssh host ls"]) {
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

  it("does not auto-approve when fullCommandText disagrees with commands[] (SDK mislabel defense)", async () => {
    const s = await setup();
    s.policy.approveForSession("t", "git");
    // commands[] mislabels the executable as trusted `git`, but the real command is `rm`.
    const r = perm(s)({ kind: "shell", fullCommandText: "rm -rf x", commands: [{ identifier: "git" }] });
    await tick();
    expect(s.transport.permissions).toHaveLength(1); // carded — `rm` (the real exec) isn't trusted
    s.transport.decision!(s.transport.permissions.at(-1)!.nonce, "deny", "u");
    expect(await r).toEqual({ kind: "denied-interactively-by-user" });
  });

  it("does not offer session/always for a multi-executable request", async () => {
    const s = await setup();
    // commands[] introduces a second executable beyond the fullCommandText one.
    void perm(s)({
      kind: "shell",
      fullCommandText: "git status",
      commands: [{ identifier: "git status" }, { identifier: "rm x" }],
    });
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

  it("reconfigure calls setModel with merged model/effort/context and tracks state", async () => {
    const s = await setup();
    await s.actor.reconfigure({ model: "gpt-5.4", effort: "high" });
    expect(s.session.setModelCalls.at(-1)).toEqual({ model: "gpt-5.4", options: { reasoningEffort: "high" } });
    expect(s.actor.config()).toEqual({ model: "gpt-5.4", effort: "high", context: undefined });
    // change only context; model+effort preserved
    await s.actor.reconfigure({ context: "long_context" });
    expect(s.session.setModelCalls.at(-1)).toEqual({
      model: "gpt-5.4",
      options: { reasoningEffort: "high", contextTier: "long_context" },
    });
    expect(s.actor.config()).toEqual({ model: "gpt-5.4", effort: "high", context: "long_context" });
  });

  it("usage() reflects the last session.usage_info event", async () => {
    const s = await setup();
    expect(s.actor.usage()).toBeUndefined();
    s.session.emit("session.usage_info", { data: { currentTokens: 1234, tokenLimit: 1_000_000 } });
    expect(s.actor.usage()).toEqual({ currentTokens: 1234, tokenLimit: 1_000_000 });
  });

  it("reconfigure resetEffort clears the effort (unsupported on the new model)", async () => {
    const s = await setup();
    await s.actor.reconfigure({ model: "m1", effort: "high" });
    expect(s.actor.config().effort).toBe("high");
    await s.actor.reconfigure({ model: "m2", resetEffort: true });
    expect(s.actor.config()).toEqual({ model: "m2", effort: undefined, context: undefined });
    expect(s.session.setModelCalls.at(-1)).toEqual({ model: "m2", options: {} }); // no reasoningEffort sent
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

import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { PendingInteractionBroker } from "../core/broker.js";
import { TurnRenderer } from "../core/turn-render.js";
import type { Decision, Transport } from "../core/transport.js";
import { normalizeSdkEvent } from "./normalize.js";
import { sanitizeForCodeBlock, hasBidiOrControls } from "../core/text-safety.js";
import { ApprovalPolicy, commandExecutable } from "../core/approval-policy.js";

const PERMISSION_TIMEOUT_MS = 5 * 60_000;
const TURN_WATCHDOG_MS = 15 * 60_000;
/** After the watchdog aborts, how long to wait for the real session.idle before
 *  declaring the session faulted and destroying it. */
const FAULT_GRACE_MS = 15_000;
/** Cap on how long the fault-path disconnect may take before we give up on it
 *  (so a hung disconnect RPC can't make a turn hang forever). */
const FAULT_DISCONNECT_MS = 5_000;
/** Max SANITIZED (display) length of a permission summary we will show. The
 *  card lives in a Discord embed description (≤4096). Beyond this we auto-deny
 *  rather than show a partial/undisplayable command. */
const MAX_CARD_LEN = 3900;

/** Safe-default permission result (deny). Used for timeout/abort and for
 *  permission kinds discopilot has no UI for (fail-closed). */
const DENY_UNAVAILABLE = { kind: "user-not-available" } as const;
const DENIED_BY_USER = { kind: "denied-interactively-by-user" } as const;
const APPROVE_ONCE = { kind: "approve-once" } as const;

/** Metadata captured at request time so a later decision can record the right
 *  approval rule. `executable` is the single command's executable (empty when a
 *  wider scope isn't offerable); `canOfferSession` gates the wider buttons. */
interface PendingPermMeta {
  executable: string;
  canOfferSession: boolean;
}

export interface SessionActorOpts {
  sessionKey: string;
  workingDirectory: string;
  model?: string;
  contextTier?: "default" | "long_context";
  broker: PendingInteractionBroker;
  transport: Transport;
  /** discopilot-side approval memory (session + persisted repo rules). */
  policy: ApprovalPolicy;
  /** Session incarnation (P1: always 1; P2 resume will vary this). */
  generation?: number;
}

/**
 * Owns one live Copilot SDK session and bridges it to a chat Transport:
 * SDK events → renderer → transport; the SDK's interactive callbacks →
 * PendingInteractionBroker → transport UI → user decision → back to the SDK.
 *
 * P1 scope: shell permission has real approve/deny UI; every other permission
 * kind and the other callbacks (ask_user / exit-plan / elicitation) fail closed
 * with the safe default so a missing UI can never wedge or silently auto-approve.
 */
export class SessionActor {
  private session!: CopilotSession;
  private renderer = new TurnRenderer();
  private readonly generation: number;
  private idleWaiters: Array<() => void> = [];
  /** Actor lifecycle. `faulted`/`closed` are terminal; `closing` means a
   *  disconnect RPC is in flight (not yet confirmed). The actor refuses new
   *  turns once it leaves `active`, so a dead/tearing-down session can never
   *  accept work. */
  private lifecycle: "active" | "closing" | "closed" | "faulted" = "active";
  /** In-flight disconnect (single-flight), so concurrent/retried disconnects
   *  share one RPC instead of re-hitting a possibly-hung endpoint. */
  private disconnectPromise?: Promise<void>;
  /** Per-nonce request metadata for building session/location approvals. */
  private readonly pendingPerms = new Map<string, PendingPermMeta>();
  /** True while a /stop abort is in flight — new permissions fail closed. */
  private aborting = false;
  private unsubscribeDecision?: () => void;
  private unsubscribeChoice?: () => void;
  private unsubscribePlan?: () => void;
  /** Per-nonce ask_user metadata (choices for index→answer mapping). */
  private readonly pendingAsk = new Map<string, { choices: string[] }>();
  /** Nonce of an ask_user awaiting a FREEFORM answer via a thread message. */
  private freeformAskNonce?: string;
  /** Per-nonce exit-plan metadata (actions for index→action mapping). */
  private readonly pendingPlan = new Map<string, { actions: string[] }>();

  private constructor(private readonly opts: SessionActorOpts) {
    this.generation = opts.generation ?? 1;
  }

  static async create(client: CopilotClient, opts: SessionActorOpts): Promise<SessionActor> {
    const actor = new SessionActor(opts);
    await actor.init(client);
    return actor;
  }

  private async init(client: CopilotClient): Promise<void> {
    this.unsubscribeDecision = this.opts.transport.onDecision((nonce, decision) =>
      this.onDecision(nonce, decision)
    );
    this.unsubscribeChoice = this.opts.transport.onChoice((nonce, index) =>
      this.onChoice(nonce, index)
    );
    this.unsubscribePlan = this.opts.transport.onPlan((nonce, action) => this.onPlan(nonce, action));

    const config: Record<string, unknown> = {
      streaming: true, // required for delta events
      workingDirectory: this.opts.workingDirectory,
      // Defense-in-depth: stop the controlled repo from influencing the agent's
      // trust boundary. enableFileHooks:false is SAFETY-critical — a repo
      // `.github/hooks` permission hook can set resolvedByHook and bypass our
      // Discord approval entirely (SDK session.js short-circuits before
      // onPermissionRequest). Config/skill discovery are disabled for the same
      // reason (a repo shouldn't reconfigure the agent).
      enableFileHooks: false,
      enableConfigDiscovery: false,
      enableSkills: false,
      onPermissionRequest: (req: unknown) => this.handlePermission(req),
      // Interactive UIs (P3): ask_user → choice buttons + freeform; exit-plan →
      // action buttons + reject. Elicitation stays fail-closed (cancel) with a
      // notice until it has its own UI. (onAutoModeSwitchRequest/onMcpAuthRequest
      // are left unset — their SDK defaults are already conservative, MCP off.)
      onUserInputRequest: (req: unknown) => this.handleUserInput(req),
      onExitPlanModeRequest: (req: unknown) => this.handleExitPlan(req),
      onElicitationRequest: async () => {
        await this.opts.transport
          .notice(this.opts.sessionKey, "ℹ️ Cancelled a structured input request (not supported yet).")
          .catch(() => {});
        return { action: "cancel" };
      },
    };
    if (this.opts.model) config["model"] = this.opts.model;
    if (this.opts.contextTier) config["contextTier"] = this.opts.contextTier;

    // The SDK's SessionConfig is a large generic; we pass a validated subset.
    this.session = await client.createSession(
      config as Parameters<CopilotClient["createSession"]>[0]
    );
    this.wireEvents();
  }

  private wireEvents(): void {
    const s = this.session as unknown as {
      on(event: string, handler: (e: unknown) => void): void;
    };
    const handle =
      (type: string) =>
      (e: unknown): void => {
        const norm = normalizeSdkEvent(type, e);
        if (!norm) return;
        this.renderer.apply(norm);
        void this.opts.transport.render(this.opts.sessionKey, this.renderer.state());
      };
    const data = (e: unknown): Record<string, unknown> =>
      (e as { data?: Record<string, unknown> })?.data ?? {};
    const str = (v: unknown): string => (typeof v === "string" ? v : "");

    s.on("assistant.message_delta", handle("assistant.message_delta"));
    s.on("assistant.message", handle("assistant.message"));
    s.on("tool.execution_start", handle("tool.execution_start"));
    s.on("tool.execution_complete", handle("tool.execution_complete"));
    s.on("session.idle", () => {
      this.aborting = false; // a real idle means any in-flight abort has settled
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    });
    s.on("session.error", (e) => {
      const d = data(e);
      void this.opts.transport.notice(this.opts.sessionKey, `⚠️ ${str(d["message"]) || "session error"}`);
    });
  }

  /** Seal the current assistant message before posting an interaction card so
   *  the card appears in chronological order and any output produced AFTER it
   *  (e.g. a tool result once approved) starts in a NEW message below the card
   *  — not edited into the message created before the card. */
  private async beginInteractionCard(): Promise<void> {
    await this.opts.transport.flush(this.opts.sessionKey).catch(() => {});
    this.opts.transport.resetTurn(this.opts.sessionKey);
    this.renderer = new TurnRenderer();
  }

  private async handlePermission(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as Record<string, unknown>;
    const kind = typeof r["kind"] === "string" ? (r["kind"] as string) : "unknown";
    if (this.aborting) return DENY_UNAVAILABLE; // tearing down — fail closed
    if (kind !== "shell") {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        `Auto-denied an unsupported permission (${kind}) — P1 supports shell only.`
      );
      return DENY_UNAVAILABLE;
    }
    const summary = summarizePermission(r);
    if (hasBidiOrControls(summary)) {
      // Bidirectional/control characters have no legitimate use in a shell
      // command and are a spoofing signal (the card would have to strip them,
      // making it differ from what actually runs). Deny outright — never
      // auto-approve a spoofing-laden command even if its executable is trusted.
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "Auto-denied: the command contains bidirectional/control characters (possible spoofing)."
      );
      return DENY_UNAVAILABLE;
    }
    // Executables of every parsed command PLUS the fullCommandText's own first
    // token. For a `simple` command the latter is authoritative, so including it
    // defends against a hypothetical SDK mislabel (commands[] says `git` while
    // fullCommandText is `rm …`): both must be trusted to auto-approve.
    const fullCommandText = typeof r["fullCommandText"] === "string" ? (r["fullCommandText"] as string) : "";
    const cmdExec = commandExecutable(fullCommandText);
    const executables = dedupe(
      [cmdExec, ...extractCommandIdentifiers(r).map(commandExecutable)].filter((e) => e.length > 0)
    );
    // A command is eligible for auto-approve / a wider scope only when it is a
    // SIMPLE command (no shell metacharacters that could chain/pipe/redirect/
    // substitute a different command) AND every executable is a safe, specific
    // name (not a shell/runtime/wrapper/exec-launcher). This keeps discopilot
    // from trusting the runtime's command parse blindly.
    const simple = isSimpleCommand(fullCommandText);
    const allSafe = executables.length > 0 && executables.every(isSafeExecutable);
    if (simple && allSafe && this.opts.policy.isApproved(this.opts.sessionKey, this.opts.workingDirectory, executables)) {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        `✓ Auto-approved (existing rule): ${executables.map((e) => `\`${e}\``).join(", ")}`
      );
      return APPROVE_ONCE;
    }
    if (sanitizeForCodeBlock(summary).length > MAX_CARD_LEN) {
      // Gate on the SANITIZED (display) length: escaping can expand the text,
      // and a card we can't render in full could hide a dangerous suffix.
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "Auto-denied a shell command too long to display in full for approval. " +
          "Run it from a terminal if intended."
      );
      return DENY_UNAVAILABLE;
    }
    // Offer session/always only for a SINGLE, simple, safe command whose sole
    // executable is the fullCommandText's own — chained/multi-command requests,
    // shells, runtimes and launchers stay per-request.
    const canOfferSession =
      simple && executables.length === 1 && cmdExec !== "" && isSafeExecutable(cmdExec);
    const singleExec = canOfferSession ? cmdExec : "";
    const { nonce, promise } = this.opts.broker.register<unknown>({
      sessionKey: this.opts.sessionKey,
      generation: this.generation,
      kind,
      timeoutMs: PERMISSION_TIMEOUT_MS,
      onDefault: () => DENY_UNAVAILABLE,
    });
    this.pendingPerms.set(nonce, { executable: singleExec, canOfferSession });
    try {
      try {
        await this.beginInteractionCard();
        await this.opts.transport.showPermission({
          nonce,
          sessionKey: this.opts.sessionKey,
          kind,
          summary,
          supported: true,
          canOfferSession,
          scopeCommands: canOfferSession ? [singleExec] : executables,
        });
      } catch {
        // Couldn't post the card (e.g. embed rejected) — settle deny now rather
        // than leave the SDK callback pending until the broker timeout. Guard
        // the notice so a second failure can't skip the finally cleanup below.
        this.opts.broker.settle(nonce, DENY_UNAVAILABLE, this.generation);
        await this.opts.transport
          .notice(this.opts.sessionKey, "Auto-denied: could not render the approval card.")
          .catch(() => {});
      }
      return await promise;
    } finally {
      this.pendingPerms.delete(nonce);
    }
  }

  private onDecision(nonce: string, decision: Decision): void {
    this.opts.broker.settle(nonce, this.buildDecision(nonce, decision), this.generation);
  }

  /** Map a UI decision to the SDK response, recording discopilot-side approval
   *  rules for the wider scopes. The SDK's native session/location approval is
   *  not honored in this CLI setup (verified), so session/always store a
   *  discopilot rule and return approve-once; future matching commands are
   *  auto-approved before a card is shown. Fail-closed: a wider decision the
   *  request didn't authorize denies. */
  private buildDecision(nonce: string, decision: Decision): unknown {
    if (decision === "deny") return DENIED_BY_USER;
    if (decision === "once") return APPROVE_ONCE;
    const meta = this.pendingPerms.get(nonce);
    if (!meta || !meta.canOfferSession || !meta.executable) return DENIED_BY_USER;
    if (decision === "session") {
      this.opts.policy.approveForSession(this.opts.sessionKey, meta.executable);
      return APPROVE_ONCE;
    }
    // decision === "always"
    this.opts.policy.approveForRepo(this.opts.workingDirectory, meta.executable);
    return APPROVE_ONCE;
  }

  // ---- ask_user (P3) ----------------------------------------------------

  private async handleUserInput(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as Record<string, unknown>;
    const question = typeof r["question"] === "string" ? (r["question"] as string) : "Copilot needs your input.";
    const choices = Array.isArray(r["choices"])
      ? (r["choices"] as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    const allowFreeform = r["allowFreeform"] !== false; // default true
    if (this.aborting) return { answer: "", wasFreeform: true };
    const { nonce, promise } = this.opts.broker.register<unknown>({
      sessionKey: this.opts.sessionKey,
      generation: this.generation,
      kind: "ask_user",
      timeoutMs: PERMISSION_TIMEOUT_MS,
      onDefault: () => ({ answer: "(no response from operator)", wasFreeform: true }),
    });
    this.pendingAsk.set(nonce, { choices });
    if (allowFreeform) this.freeformAskNonce = nonce;
    try {
      try {
        await this.beginInteractionCard();
        await this.opts.transport.showUserInput({
          nonce,
          sessionKey: this.opts.sessionKey,
          question,
          choices,
          allowFreeform,
        });
      } catch {
        this.opts.broker.settle(
          nonce,
          { answer: "(could not present the question)", wasFreeform: true },
          this.generation
        );
      }
      return await promise;
    } finally {
      this.pendingAsk.delete(nonce);
      if (this.freeformAskNonce === nonce) this.freeformAskNonce = undefined;
    }
  }

  private onChoice(nonce: string, index: number): void {
    const meta = this.pendingAsk.get(nonce);
    if (!meta || index < 0 || index >= meta.choices.length) return;
    this.opts.broker.settle(nonce, { answer: meta.choices[index]!, wasFreeform: false }, this.generation);
  }

  /** Consume a thread message as the freeform answer to a pending ask_user, if
   *  one is awaiting freeform. Returns true if the message was consumed. */
  tryConsumeFreeform(text: string): boolean {
    const nonce = this.freeformAskNonce;
    if (!nonce) return false;
    const settled = this.opts.broker.settle(
      nonce,
      { answer: text, wasFreeform: true },
      this.generation
    );
    if (settled) this.freeformAskNonce = undefined;
    return settled;
  }

  // ---- exit-plan (P3) ---------------------------------------------------

  private async handleExitPlan(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as Record<string, unknown>;
    const summary = typeof r["summary"] === "string" ? (r["summary"] as string) : "Copilot proposes to proceed.";
    const planContent = typeof r["planContent"] === "string" ? (r["planContent"] as string) : undefined;
    const actions = Array.isArray(r["actions"])
      ? (r["actions"] as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    const recommendedAction =
      typeof r["recommendedAction"] === "string" ? (r["recommendedAction"] as string) : actions[0] ?? "";
    if (this.aborting) return { approved: false, feedback: "Session aborting." };
    const { nonce, promise } = this.opts.broker.register<unknown>({
      sessionKey: this.opts.sessionKey,
      generation: this.generation,
      kind: "exit_plan",
      timeoutMs: PERMISSION_TIMEOUT_MS,
      onDefault: () => ({ approved: false, feedback: "No response from the operator." }),
    });
    this.pendingPlan.set(nonce, { actions });
    try {
      try {
        await this.beginInteractionCard();
        await this.opts.transport.showPlan({
          nonce,
          sessionKey: this.opts.sessionKey,
          summary,
          actions,
          recommendedAction,
          ...(planContent ? { planContent } : {}),
        });
      } catch {
        this.opts.broker.settle(
          nonce,
          { approved: false, feedback: "Could not present the plan." },
          this.generation
        );
      }
      return await promise;
    } finally {
      this.pendingPlan.delete(nonce);
    }
  }

  private onPlan(nonce: string, action: number | "reject"): void {
    if (action === "reject") {
      this.opts.broker.settle(nonce, { approved: false, feedback: "Rejected via Discord." }, this.generation);
      return;
    }
    const meta = this.pendingPlan.get(nonce);
    const selectedAction = meta && action >= 0 && action < meta.actions.length ? meta.actions[action] : undefined;
    this.opts.broker.settle(
      nonce,
      { approved: true, ...(selectedAction ? { selectedAction } : {}) },
      this.generation
    );
  }

  /** Send a user prompt, starting a fresh turn's render state. Rejects once the
   *  actor is closed/faulted so a dead session can't accept new work. */
  async send(prompt: string): Promise<void> {
    if (this.lifecycle !== "active") {
      throw new Error(`session is ${this.lifecycle} and cannot accept new prompts`);
    }
    this.renderer = new TurnRenderer();
    await (this.session as unknown as { send(o: { prompt: string }): Promise<unknown> }).send({ prompt });
  }

  /** True once the actor has faulted (needs a fresh /new; can't be reused). */
  isFaulted(): boolean {
    return this.lifecycle === "faulted";
  }

  /**
   * Run one prompt to completion. The idle waiter is armed BEFORE `send` so a
   * fast `session.idle` cannot be missed (lost-wakeup). Completion is driven by
   * the real `session.idle` event. If a turn runs past `watchdogMs`, the
   * watchdog ABORTS it (which makes the session go idle → normal completion,
   * reported as a timeout). If even the abort doesn't yield idle within a grace
   * window, the session is destroyed (faulted) so it is never reused mid-turn.
   */
  async runTurn(prompt: string, watchdogMs = TURN_WATCHDOG_MS): Promise<void> {
    const idle = this.nextIdle();
    await this.send(prompt);
    const outcome = await this.awaitTurnEnd(idle, watchdogMs);
    if (outcome === "watchdog") {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "⏱️ Turn exceeded the time limit and was aborted."
      );
    } else if (outcome === "faulted") {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "⚠️ Turn did not stop cleanly; the session was reset. Start a new one with /new."
      );
    }
  }

  /** Resolve when the turn truly ends. Order of finalization:
   *  - real `session.idle` → "idle" (or "watchdog" if the watchdog aborted it);
   *  - abort didn't produce idle within the grace window → "faulted" (session
   *    destroyed). Never fabricates idle. */
  private awaitTurnEnd(
    idle: Promise<void>,
    watchdogMs: number
  ): Promise<"idle" | "watchdog" | "faulted"> {
    return new Promise((resolve) => {
      let settled = false;
      let watchdogFired = false;
      let wd: ReturnType<typeof setTimeout>;
      let hard: ReturnType<typeof setTimeout>;
      const done = (r: "idle" | "watchdog" | "faulted"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(wd);
        clearTimeout(hard);
        resolve(r);
      };
      void idle.then(() => done(watchdogFired ? "watchdog" : "idle"));
      wd = setTimeout(() => {
        watchdogFired = true;
        void this.stop(); // abort; expect session.idle to follow
      }, watchdogMs);
      hard = setTimeout(() => {
        // Permanently fault the actor (it will refuse new turns) and best-effort
        // destroy the runtime session, but never let a hung disconnect RPC keep
        // the turn pending — cap it and resolve "faulted" regardless.
        void this.markFaulted().finally(() => done("faulted"));
      }, watchdogMs + FAULT_GRACE_MS);
      (wd as { unref?: () => void }).unref?.();
      (hard as { unref?: () => void }).unref?.();
    });
  }

  /** A promise that resolves the next time the session goes idle. */
  private nextIdle(): Promise<void> {
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Abort the current turn and settle any pending prompts (deny). New
   *  permissions fail closed until the real `session.idle` arrives (which
   *  clears `aborting`). Returns whether the abort call itself succeeded. */
  async stop(): Promise<boolean> {
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    const s = this.session as unknown as { abort?: () => Promise<unknown> };
    try {
      await s.abort?.();
      return true;
    } catch {
      return false;
    }
  }

  state() {
    return this.renderer.state();
  }

  async disconnect(): Promise<void> {
    if (this.lifecycle === "closed") return; // confirmed torn down — no-op
    if (this.lifecycle === "faulted") {
      // A prior teardown failed: never report success (which would let /new
      // delete the fence over a maybe-live runtime). Stay a fence.
      throw new Error("session has faulted; disconnect cannot be confirmed");
    }
    if (this.disconnectPromise) return this.disconnectPromise; // single-flight
    this.lifecycle = "closing";
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    this.opts.policy.clearSession(this.opts.sessionKey);
    this.unsubscribeDecision?.();
    this.unsubscribeChoice?.();
    this.unsubscribePlan?.();
    // Transition to `closed` ONLY after the RPC confirms; on failure become a
    // permanent fault fence and rethrow, so a retry can't masquerade as success.
    this.disconnectPromise = this.session.disconnect().then(
      () => {
        this.lifecycle = "closed";
      },
      (err) => {
        this.lifecycle = "faulted";
        this.disconnectPromise = undefined;
        throw err;
      }
    );
    return this.disconnectPromise;
  }

  /** Terminal fault path: mark the actor faulted (rejects further turns) and
   *  best-effort destroy the runtime session, bounded so a hung disconnect RPC
   *  can't stall the caller. */
  private async markFaulted(): Promise<void> {
    if (this.lifecycle !== "active") return;
    this.lifecycle = "faulted";
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    this.opts.policy.clearSession(this.opts.sessionKey);
    this.unsubscribeDecision?.();
    this.unsubscribeChoice?.();
    this.unsubscribePlan?.();
    const timeout = new Promise<void>((res) => {
      const t = setTimeout(res, FAULT_DISCONNECT_MS);
      (t as { unref?: () => void }).unref?.();
    });
    await Promise.race([
      (this.session.disconnect() as Promise<unknown>).catch(() => {}),
      timeout,
    ]);
  }
}

/** Executables that must NEVER get a session/repo "always" scope, because
 *  approving them would auto-run essentially arbitrary code: generic shells,
 *  language runtimes that execute arbitrary programs, and wrappers/dispatchers
 *  that launch OTHER commands. These stay per-request. */
const UNSAFE_EXECUTABLES = new Set([
  // shells / interpreters
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe",
  "bash", "sh", "zsh", "dash", "ksh", "fish", "wsl", "wsl.exe",
  // language runtimes (run arbitrary code)
  "python", "python3", "py", "node", "nodejs", "ruby", "perl", "php", "deno", "bun",
  // wrappers / dispatchers + exec-launchers (launch other commands, often with
  // metacharacter-free payloads: find -exec, ssh ProxyCommand, tar --to-command)
  "env", "sudo", "doas", "su", "npx", "xargs", "nice", "timeout", "watch",
  "time", "nohup", "command", "exec", "eval", "start", "call",
  "find", "ssh", "scp", "sftp", "rsync", "tar", "docker", "podman", "awk", "cmake",
]);

function isUnsafeExecutable(exe: string): boolean {
  return UNSAFE_EXECUTABLES.has(exe.trim().toLowerCase());
}

/** A safe, specific executable name we may offer a wider scope for: a bare
 *  identifier (no path separators, quotes or spaces) that isn't a shell/runtime/
 *  wrapper. Rejects mis-derived tokens like `"C:\Program` (path with space). */
function isSafeExecutable(exe: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(exe) && !isUnsafeExecutable(exe);
}

/** A command is "simple" (safe to auto-approve / offer a wider scope for) only
 *  if it has NO shell metacharacters that could chain, pipe, redirect, or
 *  substitute a DIFFERENT command in — since discopilot trusts the runtime's
 *  `commands[]` parse and a false negative there would run untrusted code. When
 *  any of these appear, the request always shows a per-request card instead. */
function isSimpleCommand(fullCommandText: string): boolean {
  return fullCommandText.length > 0 && !/[;&|<>`$()\r\n]/.test(fullCommandText);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Pull parsed command identifiers (e.g. ["git"]) from a shell permission
 *  request, used to scope session/location approvals. */
function extractCommandIdentifiers(r: Record<string, unknown>): string[] {
  const cmds = r["commands"];
  if (!Array.isArray(cmds)) return [];
  const ids = cmds
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>)["identifier"] : undefined))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  return [...new Set(ids)];
}

/**
 * Build the COMPLETE human-readable request summary for a shell permission
 * card. Surfaces every risk-relevant structured field the SDK provides
 * (PermissionRequestShell) so the operator approves what will actually run —
 * intention, full command, warnings, sandbox-bypass request, write
 * redirection, and touched paths. The "SANDBOX BYPASS" marker is detected by
 * the transport to escalate the card's styling.
 */
function summarizePermission(r: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const parts: string[] = [];
  const intention = str(r["intention"]);
  if (intention) parts.push(`intent: ${intention}`);
  const cmd = str(r["fullCommandText"]);
  if (cmd) parts.push(`$ ${cmd}`);
  const warning = str(r["warning"]);
  if (warning) parts.push(`⚠️ WARNING: ${warning}`);
  if (r["requestSandboxBypass"] === true) {
    const reason = str(r["requestSandboxBypassReason"]);
    parts.push(`⚠️ SANDBOX BYPASS requested${reason ? `: ${reason}` : ""}`);
  }
  if (r["hasWriteFileRedirection"] === true) parts.push("• writes files via redirection (>)");
  const paths = Array.isArray(r["possiblePaths"]) ? (r["possiblePaths"] as unknown[]) : [];
  const pathList = paths.filter((p): p is string => typeof p === "string");
  if (pathList.length) parts.push(`• paths: ${pathList.join(", ")}`);
  if (parts.length === 0) {
    // Unknown shape — show the raw request rather than approve blind.
    try {
      parts.push(JSON.stringify(r));
    } catch {
      parts.push(String(r));
    }
  }
  return parts.join("\n");
}

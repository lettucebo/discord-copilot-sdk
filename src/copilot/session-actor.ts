import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { PendingInteractionBroker } from "../core/broker.js";
import { TurnRenderer } from "../core/turn-render.js";
import type { Decision, Transport } from "../core/transport.js";
import { normalizeSdkEvent } from "./normalize.js";

const PERMISSION_TIMEOUT_MS = 5 * 60_000;
const TURN_WATCHDOG_MS = 15 * 60_000;
/** Max raw permission-summary length we will display for approval. Beyond this
 *  we auto-deny rather than show a command we can't render in full (a truncated
 *  approval could hide a dangerous suffix). */
const MAX_PERMISSION_SUMMARY = 3000;

/** Safe-default permission result (deny). Used for timeout/abort and for
 *  permission kinds discopilot has no UI for (fail-closed). */
const DENY_UNAVAILABLE = { kind: "user-not-available" } as const;
const APPROVE_ONCE = { kind: "approve-once" } as const;
const DENIED_BY_USER = { kind: "denied-interactively-by-user" } as const;

export interface SessionActorOpts {
  sessionKey: string;
  workingDirectory: string;
  model?: string;
  contextTier?: "default" | "long_context";
  broker: PendingInteractionBroker;
  transport: Transport;
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
  /** True while a /stop abort is in flight — new permissions fail closed. */
  private aborting = false;
  private unsubscribeDecision?: () => void;

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
      // Fail closed until P3 builds real UIs for these. onUserInputRequest must
      // return a valid UserInputResponse ({answer,wasFreeform}); an empty answer
      // is the safe decline. (onAutoModeSwitchRequest/onMcpAuthRequest are left
      // unset — their SDK defaults are already conservative, and MCP is off.)
      onUserInputRequest: async () => ({ answer: "", wasFreeform: true }),
      onElicitationRequest: async () => ({ action: "cancel" }),
      onExitPlanModeRequest: async () => ({ approved: false, feedback: "Not available in P1." }),
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
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    });
    s.on("session.error", (e) => {
      const d = data(e);
      void this.opts.transport.notice(this.opts.sessionKey, `⚠️ ${str(d["message"]) || "session error"}`);
    });
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
    if (summary.length > MAX_PERMISSION_SUMMARY) {
      // Don't show a command we can't render in full — a truncated approval
      // could hide a dangerous suffix. Deny and tell the operator.
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "Auto-denied a shell command too long to display in full for approval. " +
          "Run it from a terminal if intended."
      );
      return DENY_UNAVAILABLE;
    }
    const { nonce, promise } = this.opts.broker.register<unknown>({
      sessionKey: this.opts.sessionKey,
      generation: this.generation,
      kind,
      timeoutMs: PERMISSION_TIMEOUT_MS,
      onDefault: () => DENY_UNAVAILABLE,
    });
    await this.opts.transport.showPermission({
      nonce,
      sessionKey: this.opts.sessionKey,
      kind,
      summary,
      supported: true,
    });
    return await promise;
  }

  private onDecision(nonce: string, decision: Decision): void {
    this.opts.broker.settle(
      nonce,
      decision === "allow" ? APPROVE_ONCE : DENIED_BY_USER,
      this.generation
    );
  }

  /** Send a user prompt, starting a fresh turn's render state. */
  async send(prompt: string): Promise<void> {
    this.renderer = new TurnRenderer();
    await (this.session as unknown as { send(o: { prompt: string }): Promise<unknown> }).send({ prompt });
  }

  /**
   * Run one prompt to completion. The idle waiter is armed BEFORE `send` so a
   * fast `session.idle` cannot be missed (lost-wakeup). Completion is driven by
   * the real `session.idle` event — not a wall clock — so a long or
   * permission-gated turn is never falsely declared finished. A watchdog only
   * fires as a last resort and ABORTS the turn (which makes the session go
   * idle); it never fabricates an idle.
   */
  async runTurn(prompt: string, watchdogMs = TURN_WATCHDOG_MS): Promise<void> {
    const idle = this.nextIdle();
    await this.send(prompt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    const watchdog = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        watchdogFired = true;
        void this.stop().finally(() => resolve());
      }, watchdogMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([idle, watchdog]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (watchdogFired) {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        "⏱️ Turn exceeded the time limit and was aborted."
      );
    }
  }

  /** A promise that resolves the next time the session goes idle. */
  private nextIdle(): Promise<void> {
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Abort the current turn and settle any pending prompts (deny). Rejects new
   *  permissions while in flight. Returns whether the underlying abort call
   *  succeeded so the caller can report truthfully. */
  async stop(): Promise<boolean> {
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    const s = this.session as unknown as { abort?: () => Promise<unknown> };
    try {
      await s.abort?.();
      return true;
    } catch {
      return false;
    } finally {
      this.aborting = false;
    }
  }

  state() {
    return this.renderer.state();
  }

  async disconnect(): Promise<void> {
    this.aborting = true;
    this.opts.broker.abortSession(this.opts.sessionKey);
    this.unsubscribeDecision?.();
    try {
      await this.session.disconnect();
    } catch {
      /* best effort */
    }
  }
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

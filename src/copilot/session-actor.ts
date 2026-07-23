import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { PendingInteractionBroker } from "../core/broker.js";
import { TurnRenderer, type NormEvent } from "../core/turn-render.js";
import type { Decision, Transport } from "../core/transport.js";

const PERMISSION_TIMEOUT_MS = 5 * 60_000;

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

  private constructor(private readonly opts: SessionActorOpts) {
    this.generation = opts.generation ?? 1;
  }

  static async create(client: CopilotClient, opts: SessionActorOpts): Promise<SessionActor> {
    const actor = new SessionActor(opts);
    await actor.init(client);
    return actor;
  }

  private async init(client: CopilotClient): Promise<void> {
    this.opts.transport.onDecision((nonce, decision) => this.onDecision(nonce, decision));

    const config: Record<string, unknown> = {
      streaming: true, // required for delta events
      onPermissionRequest: (req: unknown) => this.handlePermission(req),
      // Fail closed until P3 builds real UIs for these.
      onUserInputRequest: async () => ({ kind: "cancelled" }),
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
    const push = (e: NormEvent): void => {
      this.renderer.apply(e);
      void this.opts.transport.render(this.opts.sessionKey, this.renderer.state());
    };
    const data = (e: unknown): Record<string, unknown> =>
      (e as { data?: Record<string, unknown> })?.data ?? {};
    const str = (v: unknown): string => (typeof v === "string" ? v : "");

    s.on("assistant.message_delta", (e) => {
      const d = data(e);
      push({ type: "message_delta", agentId: d["agentId"] as string | undefined, text: str(d["delta"]) || str(d["text"]) || str(d["content"]) });
    });
    s.on("assistant.message", (e) => {
      const d = data(e);
      push({ type: "message", agentId: d["agentId"] as string | undefined, content: str(d["content"]) });
    });
    s.on("tool.execution_start", (e) => {
      const d = data(e);
      push({ type: "tool_start", agentId: d["agentId"] as string | undefined, id: str(d["toolCallId"]) || str(d["id"]), name: str(d["name"]) || str(d["toolName"]) });
    });
    s.on("tool.execution_complete", (e) => {
      const d = data(e);
      push({ type: "tool_complete", agentId: d["agentId"] as string | undefined, id: str(d["toolCallId"]) || str(d["id"]), status: str(d["status"]) || "completed" });
    });
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
    if (kind !== "shell") {
      await this.opts.transport.notice(
        this.opts.sessionKey,
        `Auto-denied an unsupported permission (${kind}) — P1 supports shell only.`
      );
      return DENY_UNAVAILABLE;
    }
    const summary = summarizePermission(r);
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

  /** Resolve when the session next goes idle (or after `timeoutMs`). */
  waitIdle(timeoutMs = 90_000): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.idleWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Abort the current turn and settle any pending prompts (deny). */
  async stop(): Promise<void> {
    this.opts.broker.abortSession(this.opts.sessionKey);
    const s = this.session as unknown as { abort?: () => Promise<unknown> };
    try {
      await s.abort?.();
    } catch {
      /* best effort */
    }
  }

  state() {
    return this.renderer.state();
  }

  async disconnect(): Promise<void> {
    this.opts.broker.abortSession(this.opts.sessionKey);
    try {
      await this.session.disconnect();
    } catch {
      /* best effort */
    }
  }
}

/** Build the complete, human-readable request summary for a permission card. */
function summarizePermission(r: Record<string, unknown>): string {
  const parts: string[] = [];
  const intention = r["intention"];
  if (typeof intention === "string" && intention) parts.push(`intent: ${intention}`);
  const cmd = r["fullCommandText"];
  if (typeof cmd === "string" && cmd) parts.push(`$ ${cmd}`);
  else {
    // Fall back to the raw structured request (never truncated for approval).
    try {
      parts.push(JSON.stringify(r));
    } catch {
      parts.push(String(r));
    }
  }
  return parts.join("\n");
}

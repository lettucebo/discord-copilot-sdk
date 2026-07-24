import { randomUUID } from "node:crypto";

/** Public, read-only view of a pending interaction. */
export interface PendingView {
  nonce: string;
  sessionKey: string;
  generation: number;
  kind: string;
  createdAt: number;
  expiresAt: number;
}

interface Entry {
  nonce: string;
  sessionKey: string;
  generation: number;
  kind: string;
  createdAt: number;
  expiresAt: number;
  settled: boolean;
  resolve: (v: unknown) => void;
  onDefault: () => unknown;
  timer: ReturnType<typeof setTimeout>;
}

export interface RegisterOpts<T> {
  /** Session this prompt belongs to (thread key). */
  sessionKey: string;
  /** Session incarnation/generation captured at registration. This is an
   *  IN-MEMORY, in-process fence: a settle carrying a stale generation is
   *  rejected (e.g. an in-process resume that replaced the actor). It is NOT a
   *  durable cross-restart fence — after a crash the process, this broker, and
   *  all pending entries are gone, and a pre-crash Discord card carries a nonce
   *  absent from the fresh broker, so it can't settle anything anyway. */
  generation: number;
  /** Discriminator (permission kind / "ask_user" / "exit_plan" / "elicitation"). */
  kind: string;
  timeoutMs: number;
  /** Value used when the request times out OR is aborted — must be the SAFE
   *  default (deny/cancel). */
  onDefault: () => T;
}

/**
 * Central broker for interactive prompts the agent raises (permission,
 * ask_user, exit-plan, elicitation). It owns the correctness-critical state so
 * an SDK callback the runtime is `await`ing can never wedge:
 *
 * - each request gets a cryptographically-random nonce;
 * - it settles **exactly once** (first of: user decision, timeout, abort);
 * - a settle is rejected if the nonce is unknown/already-settled or the session
 *   generation is stale (in-process/post-resume within one run; see RegisterOpts);
 * - timeout and abort settle with the SAFE default (deny/cancel), never leaving
 *   the callback pending;
 * - a single finalizer clears the timer and removes the entry.
 *
 * Discord-agnostic: the transport posts UI for a nonce and calls `settle` when
 * the user clicks; tests use a fake transport.
 */
export class PendingInteractionBroker {
  private readonly entries = new Map<string, Entry>();

  /** Register a pending request. Returns its nonce and a promise the SDK
   *  callback should return (the runtime awaits it). */
  register<T>(opts: RegisterOpts<T>): { nonce: string; promise: Promise<T> } {
    const nonce = randomUUID();
    const now = Date.now();
    let resolve!: (v: unknown) => void;
    const promise = new Promise<T>((r) => {
      resolve = r as (v: unknown) => void;
    });
    const timer = setTimeout(() => this.fire(nonce), opts.timeoutMs);
    // Don't keep the process alive just for a pending prompt.
    (timer as { unref?: () => void }).unref?.();
    this.entries.set(nonce, {
      nonce,
      sessionKey: opts.sessionKey,
      generation: opts.generation,
      kind: opts.kind,
      createdAt: now,
      expiresAt: now + opts.timeoutMs,
      settled: false,
      resolve,
      onDefault: opts.onDefault,
      timer,
    });
    return { nonce, promise };
  }

  /**
   * Settle a pending request with an explicit result (a user's decision).
   * Returns true iff this call settled it; false when the nonce is
   * unknown/already-settled or the generation is stale.
   */
  settle<T>(nonce: string, result: T, expectGeneration?: number): boolean {
    const e = this.entries.get(nonce);
    if (!e || e.settled) return false;
    if (expectGeneration !== undefined && e.generation !== expectGeneration) return false;
    this.finalize(e, result);
    return true;
  }

  /** A pending request's public view, or undefined if unknown/settled. */
  get(nonce: string): PendingView | undefined {
    const e = this.entries.get(nonce);
    if (!e || e.settled) return undefined;
    const { resolve, onDefault, timer, settled, ...view } = e;
    void resolve;
    void onDefault;
    void timer;
    void settled;
    return view;
  }

  /** Abort matching pending requests with their SAFE default (deny/cancel).
   *  Used on /stop, disconnect, delete, runtime loss, and shutdown. */
  abort(filter?: (v: PendingView) => boolean): number {
    let n = 0;
    for (const e of [...this.entries.values()]) {
      if (e.settled) continue;
      if (filter && !filter(this.toView(e))) continue;
      this.finalize(e, e.onDefault());
      n++;
    }
    return n;
  }

  /** Abort every pending request for a session (e.g. on session teardown). */
  abortSession(sessionKey: string): number {
    return this.abort((v) => v.sessionKey === sessionKey);
  }

  /** Number of currently-pending requests. */
  get size(): number {
    return this.entries.size;
  }

  private fire(nonce: string): void {
    const e = this.entries.get(nonce);
    if (!e || e.settled) return;
    this.finalize(e, e.onDefault());
  }

  private finalize(e: Entry, result: unknown): void {
    e.settled = true;
    clearTimeout(e.timer);
    this.entries.delete(e.nonce);
    e.resolve(result);
  }

  private toView(e: Entry): PendingView {
    return {
      nonce: e.nonce,
      sessionKey: e.sessionKey,
      generation: e.generation,
      kind: e.kind,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
    };
  }
}

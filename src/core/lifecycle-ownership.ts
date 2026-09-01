import type { InstanceLock } from "./single-instance.js";

/**
 * Who is allowed to let go of this process's single-instance lock, and when.
 *
 * The lock is not a formality: it is the only thing stopping a successor
 * instance from reconciling the same session records and the same git
 * checkouts that this process may still be writing to. Deciding when to release
 * it turned out to need four unrelated-looking facts at once —
 *
 *  - is a retry attempt still inside a REST call, a `git worktree add` or an SDK
 *    resume that nobody can recall?
 *  - is an explicit teardown (`/end`) part-way through proving a worktree
 *    removable?
 *  - is there a runtime we could not prove stopped, still holding a checkout
 *    (and, on Windows, a root capability)?
 *  - has the app's own resource teardown run yet?
 *
 * — and every time one of them was answered in a different place, the release
 * escaped through the gap between them: bootstrap released a lock the app was
 * deliberately holding; a cancelled attempt wrote to a store after the lock was
 * gone; a barrier was overwritten by the attempt that replaced it. This module
 * exists so those four facts have exactly one home, and so "release" is a
 * conclusion drawn from all of them at every transition rather than a statement
 * made by whoever happened to finish last.
 *
 * The external interface is deliberately four operations. Anything that needs a
 * fifth is a sign that a caller wants to reason about ownership itself, which is
 * the mistake this replaces.
 */

/**
 * A cleanup this process owes the outside world before it may let go.
 *
 * The object CONTAINS its payload — the actor, the retained root, whatever it
 * needs — by closure or field. That is the point: the previous design kept a
 * separate map of "unconfirmed" things beside the lifecycle state, and the two
 * drifted. An obligation nobody can discharge is not a leak to be tidied away;
 * it is the reason the lock is still held.
 */
export interface CleanupObligation {
  /** For logs. Should name the thing, not the failure. */
  describe(): string;
  /**
   * ONE bounded attempt. `true` means it is genuinely discharged and the
   * payload may be dropped; `false` (or a rejection, or a hang) means it is not,
   * and it keeps gating the release.
   */
  attempt(): Promise<boolean>;
}

/**
 * A retained obligation, identified by identity rather than by key.
 *
 * `attempt`/`discharge` do nothing unless this handle is still the retained one
 * for its key. A newer registration cannot make an older, unproven obligation
 * disappear, and an older handle cannot discharge a newer one.
 */
export interface ObligationHandle {
  readonly key: string;
  /** Still the live registration for its key? */
  readonly retained: boolean;
  /**
   * ONE bounded attempt. `true` means it is genuinely no longer owed and the
   * payload may be dropped; `false` (or a rejection, or a hang) means it is
   * still owed, and it keeps gating the release.
   *
   * Note the asymmetry with `CleanupObligation.attempt()`: a body may discharge
   * its own handle — having proved the part that gates the LOCK — and still
   * report `false` because some other part of its cleanup did not complete.
   * What comes back here is whether the obligation is still registered.
   */
  attempt(): Promise<boolean>;
  /** Drop it without attempting — for a caller that has already proved it gone. */
  discharge(): void;
}

/** What a body running under `runExclusive` may ask and record. */
export interface OwnedScope {
  /**
   * Why this body must stop touching durable state and the outside world, or
   * `undefined`. Re-read after EVERY await: the answer changes underneath.
   */
  lostReason(): string | undefined;
  /** Register a cleanup. First registration for a key wins. */
  retain(key: string, obligation: CleanupObligation): ObligationHandle;
  obligation(key: string): ObligationHandle | undefined;
}

/** What a body running under `runTeardown` may ask and record. */
export interface TeardownScope {
  /**
   * Why this body must stop, or `undefined`.
   *
   * A teardown is admitted only while the process is running, but it is a long
   * chain of awaits and shutdown can begin inside it — so this must be re-read
   * after every await, before anything new is created. A rebind that builds an
   * SDK session after `stop()` began is a runtime nobody is left to tear down.
   */
  lostReason(): string | undefined;
  /**
   * Wait, boundedly, for every exclusive scope on this thread to settle.
   * `false` means one did not — the caller must REFUSE to do anything
   * destructive, not assume it finished.
   */
  joinExclusive(threadId: string): Promise<boolean>;
  retain(key: string, obligation: CleanupObligation): ObligationHandle;
  obligation(key: string): ObligationHandle | undefined;
}

export type ExclusiveOutcome<T> = { ran: true; value: T } | { ran: false; reason: string };
/** A teardown is declined once shutdown has begun: starting one then would
 *  build resources the armed teardown has already walked past. */
export type TeardownOutcome<T> = { ran: true; value: T } | { ran: false; reason: string };

export interface LifecycleOwnership {
  /**
   * Register the process-wide resource teardown, re-armably; the LAST arm wins.
   *
   * Called twice on purpose: a narrow cleanup as soon as there is something to
   * clean (the Copilot client), and a wider one once the app owns more.
   *
   * Returns `false` when shutdown has already begun. The cleanup is then run as
   * a best-effort obligation, but **that is defensive, not a guarantee**: if the
   * lock has already been released, no obligation registered afterwards can
   * retroactively gate it. The structural guarantee is the caller's, and it is
   * the reason startup runs inside an exclusive scope — a scope prevents any
   * release until it settles, so construction and its arm cannot straddle a
   * release. A caller that sees `false` must abort construction rather than
   * treat the returned obligation as cover.
   *
   * The teardown receives a `TeardownScope` because tearing down is exactly when
   * a process discovers what it still owes: a runtime it could not confirm
   * stopped is found HERE, and has to be recorded as an obligation rather than
   * logged and forgotten.
   */
  arm(teardown: (scope: TeardownScope) => Promise<void>): boolean;
  /**
   * Run `body` as the owner of `threadId`. The scope is published SYNCHRONOUSLY,
   * before `body` is called, so a teardown that starts a moment later can see it.
   *
   * Declined only by shutdown or by an explicit teardown claim on the same
   * thread. Deliberately NOT declined by an outstanding obligation: the body's
   * own first step is to discharge it, and refusing admission would leave the
   * obligation with nobody to retry it.
   */
  runExclusive<T>(threadId: string, body: (scope: OwnedScope) => Promise<T>): Promise<ExclusiveOutcome<T>>;
  /**
   * Run `body` as the explicit teardown of `threadId`. The claim is published
   * synchronously and is counted, so a nested claim from the same command does
   * not release the outer one.
   */
  runTeardown<T>(threadId: string, body: (scope: TeardownScope) => Promise<T>): Promise<TeardownOutcome<T>>;
  /**
   * Begin (or join) shutdown. Single-flight, and NOT `async`, so every caller
   * gets the identical promise instead of a fresh wrapper around a teardown
   * that is still half done.
   *
   * The promise it returns is bounded — it is what a signal handler awaits — but
   * the RELEASE is not decided by it. Release happens when the exclusive scopes,
   * the teardown claims and the obligations are simultaneously empty, whenever
   * that turns out to be.
   */
  shutdown(): Promise<void>;
}

export interface LifecycleOwnershipOptions {
  /** Bound on joining in-flight exclusive scopes. */
  joinTimeoutMs?: number;
  /** Bound on ONE obligation attempt. */
  obligationTimeoutMs?: number;
  /** Bound on the whole armed resource teardown. Shutdown's contract is
   *  bounded, and copilot.stop() is an RPC to a runtime that can wedge. */
  teardownTimeoutMs?: number;
  /** Timer seam. Production unrefs, so a pending bound never holds the process. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?: (message: string) => void;
}

const DEFAULT_JOIN_TIMEOUT_MS = 5_000;
const DEFAULT_OBLIGATION_TIMEOUT_MS = 5_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 15_000;

const defaultTimers = {
  set(fn: () => void, ms: number): unknown {
    const t = setTimeout(fn, ms);
    // Unref'd without exception: a bound we are waiting on must never be the
    // reason the process stays alive. Real work keeps the loop alive on its own;
    // if nothing does, the process exits with the PID lock still on disk and the
    // successor reclaims it as stale.
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

interface ObligationEntry {
  key: string;
  obligation: CleanupObligation;
  handle: ObligationHandle;
  attempting?: Promise<boolean>;
}

interface ExclusiveEntry {
  threadId: string;
  settled: Promise<void>;
  settle: () => void;
}

/** Test-only inspection of the three sets the release conclusion is drawn from.
 *  Deliberately not part of `LifecycleOwnership`: a caller that needs to look at
 *  these is reasoning about ownership itself, which is the mistake this module
 *  replaces. */
export interface OwnershipInspector {
  exclusiveThreads(): string[];
  teardownClaims(): string[];
  obligationKeys(): string[];
  /** The retained handle for a key, for identity assertions. */
  obligation(key: string): ObligationHandle | undefined;
  released(): boolean;
}

class Ownership implements LifecycleOwnership {
  private state: "running" | "shutting-down" = "running";
  private armed?: (scope: TeardownScope) => Promise<void>;
  private readonly exclusive = new Map<string, Set<ExclusiveEntry>>();
  private readonly teardownClaims = new Map<string, number>();
  private readonly obligations = new Map<string, ObligationEntry>();
  private teardownComplete = false;
  private released = false;
  private releasing?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private lateArmSeq = 0;
  private readonly joinTimeoutMs: number;
  private readonly obligationTimeoutMs: number;
  private readonly teardownTimeoutMs: number;
  private readonly timers: NonNullable<LifecycleOwnershipOptions["timers"]>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly lock: InstanceLock,
    options: LifecycleOwnershipOptions = {}
  ) {
    this.joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
    this.obligationTimeoutMs = options.obligationTimeoutMs ?? DEFAULT_OBLIGATION_TIMEOUT_MS;
    this.teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
    this.timers = options.timers ?? defaultTimers;
    this.log = options.log ?? ((m) => console.warn(m));
  }

  // ------------------------------------------------------------------ arm --

  arm(teardown: (scope: TeardownScope) => Promise<void>): boolean {
    if (this.state === "running") {
      this.armed = teardown;
      return true;
    }
    // Too late to be torn down by shutdown. Best effort only: if the lock has
    // already been released, an obligation registered now cannot retroactively
    // gate it. This is why construction runs inside an exclusive scope — that
    // scope, not this branch, is what makes "no release before the arm" true.
    const key = `late-arm:${++this.lateArmSeq}`;
    const handle = this.retain(key, {
      describe: () => "a resource armed after shutdown began",
      attempt: async () => {
        await teardown(this.teardownScope());
        return true;
      },
    });
    if (this.released) {
      this.log(
        "ownership: a resource was armed after the lock had already been released; " +
          "cleaning it up, but it could not have gated the release. Construct inside a scope."
      );
    }
    void handle.attempt();
    return false;
  }

  private teardownScope(): TeardownScope {
    return {
      // A teardown is admitted only while running, but it is a long chain of
      // awaits and shutdown can begin inside it. A rebind that builds an SDK
      // session after `stop()` began is a runtime nobody will tear down.
      lostReason: () => (this.state === "running" ? undefined : "shutdown started"),
      joinExclusive: (id) => this.joinExclusive(id),
      retain: (key, obligation) => this.retain(key, obligation),
      obligation: (key) => this.obligations.get(key)?.handle,
    };
  }

  // -------------------------------------------------------- exclusive work --

  async runExclusive<T>(
    threadId: string,
    body: (scope: OwnedScope) => Promise<T>
  ): Promise<ExclusiveOutcome<T>> {
    // Synchronous, before `body` and therefore before its first await.
    const declined = this.declineReason(threadId);
    if (declined) return { ran: false, reason: declined };
    let settle: () => void = () => {};
    const entry: ExclusiveEntry = {
      threadId,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    };
    const set = this.exclusive.get(threadId) ?? new Set<ExclusiveEntry>();
    set.add(entry);
    this.exclusive.set(threadId, set);
    const scope: OwnedScope = {
      lostReason: () => this.lostReason(threadId),
      retain: (key, obligation) => this.retain(key, obligation),
      obligation: (key) => this.obligations.get(key)?.handle,
    };
    try {
      return { ran: true, value: await body(scope) };
    } finally {
      const live = this.exclusive.get(threadId);
      live?.delete(entry);
      if (live && live.size === 0) this.exclusive.delete(threadId);
      entry.settle();
      this.onTransition();
    }
  }

  private declineReason(threadId: string): string | undefined {
    if (this.state !== "running") return "shutdown has begun";
    if (this.teardownClaims.has(threadId)) return "an explicit teardown claimed this thread";
    return undefined;
  }

  private lostReason(threadId: string): string | undefined {
    if (this.state !== "running") return "shutdown started";
    if (this.teardownClaims.has(threadId)) return "an explicit teardown claimed this thread";
    return undefined;
  }

  // ---------------------------------------------------------- teardown work --

  async runTeardown<T>(
    threadId: string,
    body: (scope: TeardownScope) => Promise<T>
  ): Promise<TeardownOutcome<T>> {
    // Declined once shutdown has begun. A teardown started then would run past
    // the armed teardown that has already walked the live sessions — and a
    // rebind, which is one of these, would create an SDK session nobody is left
    // to tear down.
    if (this.state !== "running") return { ran: false, reason: "shutdown has begun" };
    const release = this.claimTeardown(threadId); // synchronous, counted
    const scope = this.teardownScope();
    try {
      return { ran: true, value: await body(scope) };
    } finally {
      release();
      this.onTransition();
    }
  }

  private claimTeardown(threadId: string): () => void {
    this.teardownClaims.set(threadId, (this.teardownClaims.get(threadId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.teardownClaims.get(threadId) ?? 1) - 1;
      if (remaining > 0) this.teardownClaims.set(threadId, remaining);
      else this.teardownClaims.delete(threadId);
    };
  }

  private async joinExclusive(threadId: string): Promise<boolean> {
    const set = this.exclusive.get(threadId);
    if (!set || set.size === 0) return true;
    // A expired bound is an ANSWER, not an error: the caller is told `false` and
    // must refuse, rather than being handed an exception it would only swallow.
    await this.bounded(
      Promise.all([...set].map((e) => e.settled)).then(() => undefined),
      this.joinTimeoutMs
    ).catch(() => undefined);
    const still = this.exclusive.get(threadId);
    return !still || still.size === 0;
  }

  // ----------------------------------------------------------- obligations --

  private retain(key: string, obligation: CleanupObligation): ObligationHandle {
    const existing = this.obligations.get(key);
    // FIRST wins. An existing entry is an older thing nobody proved gone, and
    // its payload is the only fence around whatever it holds.
    if (existing) return existing.handle;
    const owner = this;
    const entry = { key, obligation } as ObligationEntry;
    entry.handle = {
      key,
      get retained(): boolean {
        return owner.obligations.get(key) === entry;
      },
      attempt: () => owner.attemptObligation(entry),
      discharge: () => {
        if (owner.obligations.get(key) !== entry) return;
        owner.obligations.delete(key);
        owner.onTransition();
      },
    };
    this.obligations.set(key, entry);
    return entry.handle;
  }

  private async attemptObligation(entry: ObligationEntry): Promise<boolean> {
    if (this.obligations.get(entry.key) !== entry) return true; // already discharged
    if (entry.attempting) return entry.attempting;
    const run = (async (): Promise<boolean> => {
      let ok = false;
      try {
        ok = await this.bounded(entry.obligation.attempt(), this.obligationTimeoutMs);
      } catch {
        ok = false;
      }
      if (ok && this.obligations.get(entry.key) === entry) {
        this.obligations.delete(entry.key);
        this.onTransition();
      }
      // The answer is the SET, not what the body returned — the same question
      // the guard at the top of this method asks. A body may legitimately
      // identity-discharge its own handle and still report `false`: a detached
      // rebind incarnation whose RUNTIME is confirmed stopped no longer gates
      // the process lock, even though its dirty worktree was kept and its
      // cleanup therefore did not fully complete. Returning the body's `false`
      // there made shutdown log "could not be discharged; lock retained" about
      // an obligation that was gone, and made `/end`'s barrier check refuse for
      // a runtime already proved stopped.
      return this.obligations.get(entry.key) !== entry;
    })();
    entry.attempting = run;
    try {
      return await run;
    } finally {
      if (entry.attempting === run) entry.attempting = undefined;
    }
  }

  // -------------------------------------------------------------- shutdown --

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.beginShutdown();
    return this.shutdownPromise;
  }

  private async beginShutdown(): Promise<void> {
    this.state = "shutting-down";
    // Join first, so anything a still-running scope retains is visible to the
    // sweep below rather than appearing after it.
    for (const threadId of [...this.exclusive.keys()]) await this.joinExclusive(threadId);
    // Sweep BEFORE the armed teardown: an obligation is a promise made to the
    // outside world, and the resources the armed teardown drops may be what a
    // pending obligation needs.
    for (const entry of [...this.obligations.values()]) {
      const ok = await this.attemptObligation(entry);
      if (!ok) this.log(`ownership: ${entry.obligation.describe()} could not be discharged; lock retained`);
    }
    const teardown = this.armed;
    this.armed = undefined;
    let teardownError: unknown;
    if (teardown) {
      // Gated BEFORE it runs, discharged only when it actually completes.
      //
      // Two failures share one answer here. A teardown that throws did not prove
      // it put everything down, and a teardown that has not RETURNED has not
      // proved it either — `copilot.stop()` is an RPC to a runtime that can
      // wedge, and shutdown's contract is bounded. So the wait below is bounded
      // and the gate outlives it: `shutdown()` settles truthfully (rejecting
      // with the timeout) while the lock stays held until the teardown really
      // finishes. If it finishes later, the discharge below re-evaluates and the
      // release happens then; if it never does, the process exits with the PID
      // lock on disk for the successor to reclaim as stale.
      const gate = this.retain("armed-teardown", {
        describe: () => "resource teardown that has not been proved complete",
        // Never retried: re-running a teardown that died or wedged half-way is
        // how a half-torn-down process does more damage, not less.
        attempt: async () => false,
      });
      const running = (async () => teardown(this.teardownScope()))();
      void running.then(
        () => gate.discharge(),
        () => {
          /* a failed teardown cannot be proved complete; the gate stays */
        }
      );
      try {
        await this.bounded(running, this.teardownTimeoutMs);
      } catch (err) {
        teardownError = err;
        this.log(`ownership: armed teardown failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    this.teardownComplete = true;
    await this.evaluate();
    if (teardownError !== undefined) throw teardownError;
  }

  /** Called after EVERY transition. No countdown, no snapshot: the question is
   *  re-asked from the live state each time. */
  private onTransition(): void {
    void this.evaluate();
  }

  private async evaluate(): Promise<void> {
    if (this.released) return;
    if (this.state !== "shutting-down" || !this.teardownComplete) return; // inert before shutdown
    if (this.exclusive.size > 0 || this.teardownClaims.size > 0 || this.obligations.size > 0) return;
    this.released = true;
    this.releasing = this.lock.release().catch((err: unknown) => {
      this.log(`ownership: releasing the lock failed (${err instanceof Error ? err.message : String(err)})`);
    });
    await this.releasing;
  }

  inspector(): OwnershipInspector {
    return {
      exclusiveThreads: () => [...this.exclusive.keys()],
      teardownClaims: () => [...this.teardownClaims.keys()],
      obligationKeys: () => [...this.obligations.keys()],
      obligation: (key) => this.obligations.get(key)?.handle,
      released: () => this.released,
    };
  }

  private async bounded<T>(work: Promise<T>, ms: number): Promise<T> {
    // The loser of the race must not become an unhandled rejection: a hung or
    // failing obligation is normal here, not a programming error.
    work.catch(() => {});
    let handle: unknown;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_resolve, reject) => {
          handle = this.timers.set(() => reject(new Error("timeout")), ms);
        }),
      ]);
    } finally {
      if (handle !== undefined) this.timers.clear(handle);
    }
  }
}

export function createLifecycleOwnership(
  lock: InstanceLock,
  options: LifecycleOwnershipOptions = {}
): LifecycleOwnership {
  return new Ownership(lock, options);
}

/** Test seam: the same coordinator plus a read-only view of the three sets. */
export function createLifecycleOwnershipForTest(
  lock: InstanceLock,
  options: LifecycleOwnershipOptions = {}
): { ownership: LifecycleOwnership; inspect: OwnershipInspector } {
  const ownership = new Ownership(lock, options);
  return { ownership, inspect: ownership.inspector() };
}

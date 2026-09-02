import { existsSync } from "node:fs";
import type { PendingInteractionBroker } from "./broker.js";
import {
  describeBindingProblem,
  validateBinding,
  type Binding,
  type BindingVerdict,
} from "./binding.js";
import {
  confirmStopped,
  withTimeout,
  type ExclusiveOutcome,
  type OwnedScope,
} from "./lifecycle-ownership.js";
import { planReconcile, classifyResumeError, type ThreadStatus } from "./reconcile.js";
import type { SessionStore, SessionRecord } from "./session-store.js";
import { addWorktree, removeWorktreeIfClean } from "./worktree.js";
import type { TrustedRoot } from "./secure-open.js";
import type { SessionActor } from "../copilot/session-actor.js";

/** A reconcile failure that must stop startup (a required state transition
 *  could not be persisted), as opposed to one bad record we can skip past. */
export class FatalReconcileError extends Error {}

/**
 * Wake-ups for the same-process access-restoration retry (ADR-0002).
 *
 * ADR-0002 promises a `thread-no-access` session resumes once the bot's channel
 * access is restored **or** the bot restarts. Only the restart half was real:
 * `reconcileStartup` had exactly one production caller. Regaining access does
 * emit a `CHANNEL_UPDATE` for the CHANNEL, but that event neither names the
 * bound threads it makes resumable nor guarantees anything about a thread
 * object the bot may never have cached — a useful hint, not a correctness
 * source. A bounded periodic scan is. An event may only ever poke this loop; it
 * may never be the only trigger.
 *
 * The cadence escalates while a scan keeps finding nothing to resume, so a
 * permission left revoked for days costs one wake-up every five minutes rather
 * than one every fifteen seconds, and resets the moment a resume succeeds. With
 * no candidates at all it idles at the longest interval.
 */
const ACCESS_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

/** Timer seam for `ACCESS_RETRY_DELAYS_MS`. Tests replace it with a queue they
 *  fire by hand: real waits would be slow/flaky, and freezing global timers
 *  would also freeze the SDK and git timeouts the same process owns. */
export interface AccessRetryScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Production's scheduler: an unref'd `setTimeout`, so a pending wake-up never
 *  holds the process open. */
const defaultAccessRetryScheduler: AccessRetryScheduler = {
  set(fn: () => void, ms: number): unknown {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * How one reconcile attempt was started, and how it learns it must stop.
 *
 * `cancelled` is the retry loop's cancellation token. Startup passes none — its
 * semantics are unchanged, and it runs before the phase gate opens — but a retry
 * attempt awaits Discord, git and the runtime while `stop()` is free to run to
 * completion and release the single-instance lock. Without a token, a
 * classification that resolves after that would happily persist a terminal
 * state, drop a repo lease and post a Discord message on behalf of a process
 * that no longer owns any of it (and whose replacement may already be running
 * against the same store).
 */
export interface ReconcileAttemptOpts {
  via?: "startup" | "access-retry";
  /**
   * The lifecycle scope this attempt is running under, when it has one.
   *
   * Startup passes none — it runs before the phase gate opens and its semantics
   * are unchanged. A retry attempt always has one, and it is the single source
   * of "may I still act": shutdown, an explicit teardown claim on this thread,
   * and the barrier left by an earlier unconfirmed runtime are all answered by
   * it, rather than by three app-local maps that had to be kept in step.
   */
  scope?: OwnedScope;
}

/** Where an unconfirmed runtime for a thread is recorded. One key per thread, so
 *  the coordinator's first-wins rule IS the "never overwrite a barrier" rule.
 *
 *  Exported because the engine and the app's own shutdown sweep must agree on
 *  it EXACTLY: they retain and discharge the same barrier for one thread. */
export const runtimeObligationKey = (threadId: string): string => `runtime:${threadId}`;

/** What the app's shared capture-and-prove helper answers. Owned here because
 *  the engine consumes it; the app also uses the same shape for `/new` and
 *  rebind, which is precisely why it stays an app-side helper. */
export type ValidatedRootCapture =
  | { ok: true; trustedRoot?: TrustedRoot; binding: Binding; approvalKey: string }
  | { ok: false; verdict: Exclude<BindingVerdict, { ok: true }> };

/** One resumed runtime, before the app registers it as a live session. The
 *  broker is created by the same app-side step that creates the actor, so a
 *  registered session can never carry a broker some other actor is answering. */
export interface ResumedRuntime {
  actor: SessionActor;
  broker: PendingInteractionBroker;
}

/** What the app needs in order to build the resumed actor: the proven working
 *  directory, the repository identity approvals are stored under, and (on
 *  Windows) the capability whose ownership transfers to the actor. */
export interface ResumeActorInput {
  workDir: string;
  approvalKey: string;
  trustedRoot?: TrustedRoot;
}

/** Whether this process may still act at all, and the ownership seam every
 *  per-record attempt runs under. `LifecycleOwnership` remains the only
 *  lock-release authority; the engine merely runs inside its scopes. */
export interface ReconciliationProcessPort {
  /** True from the instant `stop()` is asked for. */
  shuttingDown(): boolean;
  /** True only while the startup phase gate is open. */
  phaseIsReady(): boolean;
  runExclusive(
    threadId: string,
    body: (scope: OwnedScope) => Promise<void>
  ): Promise<ExclusiveOutcome<void>>;
}

/** The durable and in-memory bookkeeping the app owns and the engine reads. */
export interface ReconciliationInventoryPort {
  /** Read late: a test may hand the app a different store than the one that
   *  existed when the engine was constructed. */
  store(): SessionStore;
  /** Is a live session already registered for this thread? */
  hasSession(threadId: string): boolean;
  /** The structural half of the binding proof (see `bindingOk` in the app). */
  bindingOk(rec: SessionRecord): boolean;
  acquireLocalLease(repoPath: string, threadId: string): { ok: true } | { ok: false; holder: string };
  releaseLocalLease(threadId: string): void;
  /** Refuse to reconcile against a registry that cannot be trusted. */
  assertChannelRegistryUsable(): void;
  /** Install the git-backed binding proof this pass must use. The proof itself
   *  lives with `captureValidatedRoot`, which `/new` and rebind share. */
  useBindingCheck(check: typeof validateBinding): void;
}

/** Everything outside this process: Discord, the runtime, and the notices. */
export interface ReconciliationWorldPort {
  classifyThread(
    threadId: string,
    expectedParentChannelId: string,
    opts?: { force?: boolean }
  ): Promise<ThreadStatus>;
  captureValidatedRoot(binding: Binding): Promise<ValidatedRootCapture>;
  resumeActor(rec: SessionRecord, input: ResumeActorInput): Promise<ResumedRuntime>;
  /** Register the resumed runtime as this thread's live session. Synchronous:
   *  the engine's last ownership check and this call are one atomic step. */
  registerResumedSession(rec: SessionRecord, runtime: ResumedRuntime, workDir: string): void;
  notice(threadId: string, text: string): Promise<void>;
  /** Report leftovers whose own thread can no longer receive a notice. Stays
   *  with the app because it also covers stale rebinds and stray worktrees. */
  announceUnreachableRecords(): Promise<void>;
  /** Bound on ONE discarded-runtime disconnect attempt. */
  runtimeTeardownTimeoutMs: number;
}

export interface ReconciliationPorts {
  process: ReconciliationProcessPort;
  inventory: ReconciliationInventoryPort;
  world: ReconciliationWorldPort;
}

/** Test seams on the startup pass, mirroring what `reconcileOnStartup` accepted
 *  before this orchestration moved out of the app. */
export interface ReconcileStartupOverrides {
  classifyThread?: (threadId: string, expectedParentChannelId: string) => Promise<ThreadStatus>;
  validateBinding?: typeof validateBinding;
}

/**
 * Startup and access-restoration reconciliation, and ALL of their retry state.
 *
 * The app is the phase/host adapter: it owns the phase gate, the live sessions
 * map, the local leases, the store, the binding/capture helpers `/new` and
 * rebind share, the actor options and the transport. This owns the
 * orchestration — candidate selection, the single armed wake-up, backoff, idle,
 * the once-per-thread transient notice, per-record reconciliation, resume and
 * its ownership fences, and the runtime obligations an unconfirmed teardown
 * leaves behind. `LifecycleOwnership` remains the only lock-release authority.
 */
export class ReconciliationEngine {
  /** Timer seam for the access-restoration retry loop; production uses an
   *  unref'd `setTimeout` so a pending wake-up never holds the process open. */
  private scheduler: AccessRetryScheduler;
  /** The single armed wake-up. One timer, always cleared before re-arming, so
   *  two overlapping loops cannot exist and double-resume a record. */
  private accessRetryTimer?: unknown;
  /** True only after `arm()` and until `disarm()`. A public `nudge()` before
   * startup finishes must neither run a tick nor create the first timer. */
  private armed = false;
  /** The tick in flight, if any. Doubles as the no-overlap fence (a tick awaits
   *  SDK work, so a second wake-up can otherwise land inside the first). */
  private accessRetryTickPromise?: Promise<void>;
  /** Index into `ACCESS_RETRY_DELAYS_MS`. */
  private accessRetryBackoff = 0;
  /** True when the last tick found nothing to recover. Idling at the longest
   *  delay keeps an otherwise-quiet bot from waking every 15 seconds for ever,
   *  without making "a candidate can never appear later" a correctness
   *  assumption. */
  private accessRetryIdle = false;
  /** Threads already told, once, that a retry reached the runtime and failed
   *  transiently. Volatile on purpose: a restart may repeat it once. */
  private readonly accessRetryNoticed = new Set<string>();
  /** Bound on one barrier disconnect attempt. A test seam: it must be able to
   *  exercise a HANGING teardown, not only one that rejects immediately,
   *  without spending the real bound. */
  private resumeTeardownTimeoutMs: number;
  /** Distinguishes a second unconfirmed runtime for one thread from the first.
   *  Shared with the app's shutdown sweep through `supersededRuntimeKey`, so one
   *  process never mints the same superseded key twice. */
  private supersededResumeSeq = 0;
  /** The thread classifier reconciliation actually used. Captured so the
   *  access-retry loop re-runs the SAME classification/resume path instead of
   *  growing a second, subtly different state machine beside it. */
  private reconcileClassify: (
    threadId: string,
    expectedParentChannelId: string,
    opts?: { force?: boolean }
  ) => Promise<ThreadStatus>;

  constructor(private readonly ports: ReconciliationPorts) {
    this.scheduler = defaultAccessRetryScheduler;
    this.resumeTeardownTimeoutMs = ports.world.runtimeTeardownTimeoutMs;
    this.reconcileClassify = (id, parent, opts) => this.ports.world.classifyThread(id, parent, opts);
  }

  private get store(): SessionStore {
    return this.ports.inventory.store();
  }

  private get shuttingDown(): boolean {
    return this.ports.process.shuttingDown();
  }

  private bindingOk(rec: SessionRecord): boolean {
    return this.ports.inventory.bindingOk(rec);
  }

  private acquireLocalLease(
    repoPath: string,
    threadId: string
  ): { ok: true } | { ok: false; holder: string } {
    return this.ports.inventory.acquireLocalLease(repoPath, threadId);
  }

  private releaseLocalLease(threadId: string): void {
    this.ports.inventory.releaseLocalLease(threadId);
  }

  private hasSession(threadId: string): boolean {
    return this.ports.inventory.hasSession(threadId);
  }

  private notice(threadId: string, text: string): Promise<void> {
    return this.ports.world.notice(threadId, text);
  }

  /**
   * Key for a SECOND unconfirmed runtime for one thread.
   *
   * The counter is engine state and the app's shutdown sweep asks for its keys
   * here, because both mint superseded keys for the same coordinator: two
   * independent counters would eventually hand one retained obligation's key to
   * a different runtime.
   */
  supersededRuntimeKey(threadId: string): string {
    return `${runtimeObligationKey(threadId)}#superseded-${++this.supersededResumeSeq}`;
  }

  /** Reconcile every persisted session on startup (P2). The app sets `phase` to
   *  "reconciling" (input rejected) before calling this, so resumed sessions are
   *  registered before any /new. `overrides.classifyThread` is injectable for
   *  tests. Throws on a corrupt store so startup fails closed rather than
   *  silently starting fresh. Deliberately does NOT arm the retry loop: that
   *  happens only once the phase gate has opened. */
  async reconcileStartup(overrides?: ReconcileStartupOverrides): Promise<void> {
    const classify =
      overrides?.classifyThread ??
      ((id: string, parent: string, opts?: { force?: boolean }) =>
        this.ports.world.classifyThread(id, parent, opts));
    this.reconcileClassify = classify;
    this.ports.inventory.useBindingCheck(overrides?.validateBinding ?? validateBinding);
    // BEFORE anything reads or writes a record. A registry that could not be
    // trusted would resolve to "configured default only", every record under another
    // channel would fail `bindingOk`, and reconcile would mark them `blocked` —
    // a TERMINAL state that re-enabling the channel does not undo. Checked here
    // as well as in `start()` so the ordering invariant survives a refactor.
    this.ports.inventory.assertChannelRegistryUsable();
    if (this.store.isCorrupt()) {
      // Checked once, for the whole file: a corrupt store says nothing reliable
      // about ANY session, so per-record handling would be guesswork.
      planReconcile({ corrupt: true });
      throw new Error(
        `session store at ${this.store.path()} is corrupt; refusing to start. Inspect/remove it and restart.`
      );
    }
    // Reserve every local-mode repo BEFORE the first resume attempt.
    //
    // A lease cannot be taken as a side effect of a successful resume: a
    // TRANSIENT resume failure deliberately leaves the record `active` so the
    // next restart retries it (and `/end` refuses to reap it for the same
    // reason). If that record's repo were left unheld, another thread could bind
    // it in local mode meanwhile, and the following restart would face two
    // durable claimants on one checkout with no principled way to choose.
    // Holding the lease from the moment the record is READ costs nothing when
    // the resume succeeds and is the only thing that keeps the invariant true
    // when it does not.
    for (const rec of this.store.all()) {
      if (rec.devMode !== "local" || rec.state !== "active") continue;
      if (!this.bindingOk(rec)) continue; // a record we will refuse to resume holds nothing
      const lease = this.acquireLocalLease(rec.repoPath, rec.threadId);
      if (!lease.ok) {
        console.warn(
          `reconcile: ${rec.threadId} wants ${rec.repoPath} in local mode, already claimed by ${lease.holder}; blocking.`
        );
        // A failed persist here must NOT fall through to resuming the record —
        // that would put a second agent into a checkout we just decided it may
        // not have. Fail startup instead, as with every other required
        // transition.
        if (!this.store.setState(rec.threadId, "blocked", "local-conflict")) {
          throw new FatalReconcileError(
            `reconcile: could not persist local-conflict for ${rec.threadId} at ${this.store.path()}`
          );
        }
      }
    }
    // Resume sequentially: each resume is a runtime RPC, and a burst of them on
    // startup competes with the reconnect the runtime is already doing.
    for (const rec of this.store.all()) {
      try {
        // Owned per thread, exactly like a retry attempt. A startup resume can
        // fail its `commit()` or leave a runtime it cannot confirm stopped, and
        // both must become obligations that gate the lock and stop the retry
        // loop from starting a SECOND runtime over the same worktree once the
        // phase gate opens. Nested under the process-startup scope, which is
        // keyed separately.
        const outcome = await this.ports.process.runExclusive(rec.threadId, (scope) =>
          this.reconcileRecord(rec, classify, { via: "startup", scope })
        );
        if (!outcome.ran) console.warn(`reconcile: skipping ${rec.threadId} — ${outcome.reason}`);
      } catch (err) {
        // One unusable record must not stop the others from coming back.
        if (err instanceof FatalReconcileError) throw err;
        console.warn(
          `reconcile: ${rec.threadId} failed (${err instanceof Error ? err.message : String(err)}); continuing.`
        );
      }
    }
    await this.ports.world.announceUnreachableRecords();
  }

  // -------------------------------------------- access-restoration retry --

  /**
   * Arm the one retry loop, after reconciliation and once `phase` is "ready".
   *
   * Armed here and not earlier for the same reason input is gated: a tick
   * resumes sessions, and a resume that raced the startup pass could register a
   * second live actor for one thread.
   */
  arm(): void {
    this.armed = true;
    this.accessRetryBackoff = 0;
    this.accessRetryIdle = false;
    this.scheduleAccessRetry();
  }

  /**
   * Drop the armed wake-up, synchronously.
   *
   * Deliberately says nothing about work already in flight: a tick that is
   * suspended inside the runtime is the coordinator's to join, and pretending
   * otherwise here is how a "disarmed" loop would report cleanup that had not
   * happened.
   */
  disarm(): void {
    this.armed = false;
    this.clearAccessRetryTimer();
  }

  /**
   * Run one tick now, or join the one already running.
   *
   * This is the whole of "poke the loop": an event may only ever poke it, and a
   * poke that started a SECOND overlapping tick would double-resume a record.
   * The returned promise settles after the tick (and after the re-arm it
   * schedules), which is what makes a wake-up joinable from a test.
   */
  nudge(): Promise<void> {
    if (!this.armed) return Promise.resolve();
    return this.runAccessRetryTick();
  }

  /** Re-arm the single wake-up. Always clears first: two armed timers is the
   *  concrete shape a double-resume bug would take. */
  private scheduleAccessRetry(): void {
    this.clearAccessRetryTimer();
    if (!this.armed || this.shuttingDown) return;
    const last = ACCESS_RETRY_DELAYS_MS.length - 1;
    const ms =
      (this.accessRetryIdle
        ? ACCESS_RETRY_DELAYS_MS[last]
        : ACCESS_RETRY_DELAYS_MS[this.accessRetryBackoff]) ?? ACCESS_RETRY_DELAYS_MS[0];
    this.accessRetryTimer = this.scheduler.set(() => {
      this.accessRetryTimer = undefined;
      void this.runAccessRetryTick();
    }, ms);
  }

  private clearAccessRetryTimer(): void {
    if (this.accessRetryTimer === undefined) return;
    this.scheduler.clear(this.accessRetryTimer);
    this.accessRetryTimer = undefined;
  }

  /** Start one tick unless one is already running, and re-arm afterwards. The
   *  re-arm lives here (not in the tick) so it happens exactly once per tick,
   *  including when the tick throws. */
  private runAccessRetryTick(): Promise<void> {
    const running = this.accessRetryTickPromise;
    if (running) return running; // no overlapping tick
    const attempt = this.accessRetryTick().catch((err: unknown) => {
      console.warn(
        `access-retry: tick failed (${err instanceof Error ? err.message : String(err)}); continuing.`
      );
    });
    const settled = attempt.then(() => {
      if (this.accessRetryTickPromise === settled) this.accessRetryTickPromise = undefined;
      this.scheduleAccessRetry();
    });
    this.accessRetryTickPromise = settled;
    return settled;
  }

  /**
   * One pass over the records ADR-0002 promised would come back by themselves.
   *
   * Deliberately re-reads each record immediately before acting on it: `/end`
   * may have cleared it, or a previous candidate's resume may have changed the
   * world, while this pass was awaiting the runtime.
   */
  private async accessRetryTick(): Promise<void> {
    if (this.shuttingDown || !this.ports.process.phaseIsReady()) return;
    const candidates = this.store.all().filter((r) => this.isAccessRetryCandidate(r));
    if (!candidates.length) {
      // Nothing to recover: idle at the longest delay rather than waking every
      // 15s for the life of the process. Only reconciliation writes
      // `thread-no-access`, so a new candidate cannot appear mid-run today —
      // this stays a poll, rather than disarming, so that remains a performance
      // assumption instead of a correctness one.
      this.accessRetryIdle = true;
      return;
    }
    if (this.accessRetryIdle) {
      this.accessRetryIdle = false;
      this.accessRetryBackoff = 0;
    }
    let resumed = false;
    for (const candidate of candidates) {
      if (this.shuttingDown || !this.ports.process.phaseIsReady()) return;
      const rec = this.store.get(candidate.threadId);
      if (!rec || !this.isAccessRetryCandidate(rec)) continue;
      // The scope is published SYNCHRONOUSLY here, before the attempt's first
      // await — which is the barrier retry below, not the classification — so a
      // `/end` that starts a moment later joins the real thing. Admission is
      // declined only by shutdown or by a teardown claim on this thread; an
      // outstanding barrier deliberately does NOT decline, because discharging
      // it is this body's own first step.
      const outcome = await this.ports.process.runExclusive(rec.threadId, async (scope) => {
        try {
          // A previous attempt left a runtime we could not prove stopped.
          // Resuming again would create a SECOND runtime for the same session
          // and worktree. Only a CONFIRMED teardown earns another attempt.
          const barrier = scope.obligation(runtimeObligationKey(rec.threadId));
          if (barrier && !(await barrier.attempt())) {
            console.warn(
              `access-retry: ${rec.threadId} still has an unconfirmed runtime from an earlier attempt; ` +
                `not resuming it again this wake-up.`
            );
            return;
          }
          // Do not START new external work after cancellation. The scope would
          // refuse to act on its result anyway; issuing a forced REST fetch, a
          // git rebuild and a runtime resume that nobody may use is pure cost
          // — and cost that keeps the single-instance lock held.
          const stale = scope.lostReason();
          if (stale) {
            console.warn(`access-retry: not starting work for ${rec.threadId} — ${stale}`);
            return;
          }
          // The SAME reconcile path startup uses: it re-validates the binding
          // and re-classifies the thread, and only a `valid` classification
          // resumes. A record that has meanwhile become genuinely terminal
          // under those existing rules gets the existing terminal outcome.
          //
          // `force` is not optional here: the cached channel object for a
          // thread the bot lost access to is the obfuscated stub, so an
          // unforced re-check can report "hidden" for ever.
          await this.reconcileRecord(
            rec,
            (id, parent) => this.reconcileClassify(id, parent, { force: true }),
            { via: "access-retry", scope }
          );
        } catch (err) {
          // Startup turns a failed terminal transition into a failed startup.
          // A running bot has no such lever, and one record's unwritable
          // transition is not a reason to abandon the others: log it and keep
          // the record `active`, the direction that cannot lose a conversation.
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof FatalReconcileError) console.error(`access-retry: ${msg}`);
          else console.warn(`access-retry: ${rec.threadId} failed (${msg}); continuing.`);
        }
      });
      if (!outcome.ran) console.warn(`access-retry: skipping ${rec.threadId} — ${outcome.reason}`);
      if (this.hasSession(rec.threadId)) resumed = true;
    }
    this.accessRetryBackoff = resumed
      ? 0
      : Math.min(this.accessRetryBackoff + 1, ACCESS_RETRY_DELAYS_MS.length - 1);
  }

  /**
   * A record this loop owns: still `active`, still parked on missing access,
   * and with no live session of its own. Never times out into a terminal
   * state — ADR-0002's whole point is that access loss is reversible.
   *
   * `MAX_LIVE_SESSIONS` is deliberately NOT applied. That cap gates `/new`,
   * i.e. asking for MORE work; this loop only finishes recovering a record that
   * already existed and that the startup pass would have resumed unconditionally
   * had the permission been present one minute earlier. Refusing it would strand
   * a conversation on a limit its owner never crossed, and there is no queue to
   * put it in.
   *
   * An unconfirmed-teardown barrier is deliberately NOT excluded here either:
   * that would make the record stop being a candidate, the loop would go idle,
   * and nothing would ever retry the barrier. It stays a candidate and the tick
   * clears the barrier first — see `accessRetryTick`.
   */
  private isAccessRetryCandidate(rec: SessionRecord): boolean {
    return rec.state === "active" && rec.reason === "thread-no-access" && !this.hasSession(rec.threadId);
  }

  private async reconcileRecord(
    rec: SessionRecord,
    classify: (threadId: string, expectedParentChannelId: string) => Promise<ThreadStatus>,
    opts: ReconcileAttemptOpts = {}
  ): Promise<void> {
    const retry = opts.via === "access-retry";
    let bindingOk: boolean | undefined;
    let threadStatus: ThreadStatus | undefined;
    if (rec.state === "active") {
      bindingOk = this.bindingOk(rec);
      if (bindingOk) threadStatus = await classify(rec.threadId, rec.parentChannelId);
    }
    // The one await above can outlive this process's ownership of its own state.
    // Everything below writes to disk, releases a lease or posts to Discord, so
    // the scope is asked HERE, once, covering every branch of the switch.
    const abandoned = opts.scope?.lostReason();
    if (abandoned) {
      console.warn(`reconcile: abandoning ${rec.threadId} — ${abandoned}`);
      return;
    }

    const action = planReconcile({ corrupt: false, state: rec.state, bindingOk, threadStatus });
    switch (action.kind) {
      case "fail-corrupt":
      case "fresh":
      case "retain":
        return;
      case "orphan-interrupted":
        // A required terminal transition: if it can't be persisted, that's a disk
        // problem — fail startup rather than run with a non-durable state.
        if (!this.store.setState(rec.threadId, "orphaned", "interrupted-create")) {
          throw new FatalReconcileError(`reconcile: could not persist orphaned state at ${this.store.path()}`);
        }
        return;
      case "skip": {
        // In retry mode a `skip` means only "still cannot confirm this thread",
        // and it must change NOTHING. Persisting the new reason looks harmless
        // and is not: `thread-no-access` is both this loop's candidate filter
        // and the key `/end thread:<id>` uses for ADR-0002's escape hatch, so a
        // single 429/5xx blip would park the record — un-retryable until a
        // restart, and un-clearable by its owner — which is precisely the
        // "no-access never times out into a dead end" promise being broken.
        // (A record that is genuinely terminal takes the `block` branch below,
        // in retry mode exactly as at startup.)
        if (retry) return;
        if (!this.store.setState(rec.threadId, "active", action.reason)) {
          throw new FatalReconcileError(
            `reconcile: could not persist retry reason for ${rec.threadId} at ${this.store.path()}`
          );
        }
        console.warn(
          `reconcile: not resuming ${rec.threadId} this boot (${action.reason}); active record retained for retry.`
        );
        // One notice used to serve all three skip reasons and promised every one
        // of them that restoring Discord access would bring it back. Only
        // `thread-no-access` has those semantics — it is the sole reason the
        // runtime retry loop takes as a candidate — so a `transient` fetch
        // failure was told to fix a permission that was never the problem, and
        // to expect an automatic recovery that is not coming. `/sessions`
        // already draws this line; this notice now draws the same one.
        await this.notice(
          rec.threadId,
          action.reason === "thread-no-access"
            ? "⚠️ 啟動時無法存取這個討論串（Discord 權限）。session 記錄已保留——" +
                "**恢復 bot 對該頻道的存取權後會自動復原，不必重啟**（約 15 秒起、最長 5 分鐘掃一次）。" +
                "確定不要這段對話時，可在上層頻道用 `/end thread:<id>` 清除。"
            : `⚠️ 啟動時暫時無法確認此執行緒狀態（${action.reason}），本次未復原。session 記錄已保留——` +
                "**重新啟動 bot 會再試一次**；執行中不會自動重試（自動重試只適用於 Discord 存取權問題）。"
        ).catch(() => {});
        return;
      }
      case "block":
        // A record leaving `active` for a terminal state gives up its repo. The
        // reconcile PRE-SCAN took a lease for every local+active record before
        // any thread was classified, so a thread that turns out to be gone would
        // otherwise hold its repo for the life of the process — and the only
        // command that can reap the record (`/end thread:<id>`) never touched
        // the lease either, so `/repo dev local` would report a phantom holder
        // with a deleted thread, permanently.
        if (!this.store.setState(rec.threadId, "blocked", action.reason)) {
          throw new FatalReconcileError(`reconcile: could not persist blocked state at ${this.store.path()}`);
        }
        this.releaseLocalLease(rec.threadId);
        await this.notice(
          rec.threadId,
          `⚠️ 無法復原此 session（${action.reason}）。請用 /new 開新的。`
        ).catch(() => {});
        return;
      case "resume":
        await this.resumeRecord(rec, opts);
        return;
    }
  }

  /** Resume the SDK session for an active record; register it and post an honest
   *  recovery notice. A resume failure is classified session-lost (definitive →
   *  orphaned, terminal) vs transient (record LEFT ACTIVE so a later restart
   *  retries — never dropping recoverable history). */
  async resumeRecord(rec: SessionRecord, opts: ReconcileAttemptOpts = {}): Promise<void> {
    // BEFORE the first side effect, not just before registration. The retry loop
    // reaches here after awaiting the thread classification, and `/end` or
    // shutdown can have claimed the record in that window — at which point
    // rebuilding its worktree below would put a checkout on disk that no record
    // points at, which is exactly the leftover `/end` had just finished
    // removing. `resumeOwnershipLost` is synchronous and the `addWorktree` call
    // is the next statement's first await, so nothing can land between them.
    const claimedBefore = this.resumeOwnershipLost(rec, opts);
    if (claimedBefore) {
      console.warn(`resume: not resuming ${rec.threadId} — ${claimedBefore}`);
      return;
    }
    // The worktree may be gone (hand-deleted, disk cleaned). Recreate it from
    // the branch, which git still has. Without this the resume fails, gets
    // classified `transient`, and the record is retried on EVERY boot forever —
    // unrecoverable without hand-editing the store, since /end refuses a thread
    // with no live session.
    if (rec.devMode === "worktree" && rec.branch && !existsSync(rec.workDir)) {
      try {
        await addWorktree(rec.repoPath, rec.workDir, rec.branch);
        console.warn(`reconcile: recreated missing worktree for ${rec.threadId} at ${rec.workDir}`);
      } catch (err) {
        // Terminal, not transient: retrying every boot cannot fix a tree we
        // just failed to rebuild — but only if this attempt still speaks for
        // the process. `addWorktree` was an await like any other.
        const abandoned = this.resumeOwnershipLost(rec, opts);
        if (abandoned) {
          console.warn(`resume: not terminalizing ${rec.threadId} after a failed rebuild — ${abandoned}`);
          return;
        }
        if (!this.store.setState(rec.threadId, "blocked", "worktree-missing")) {
          throw new FatalReconcileError(`reconcile: could not persist blocked state for ${rec.threadId}`);
        }
        this.releaseLocalLease(rec.threadId);
        await this.notice(
          rec.threadId,
          `⚠️ 無法復原：這個 session 的工作目錄不存在，且重建失敗（${err instanceof Error ? err.message : String(err)}）。` +
            `分支 \`${rec.branch}\` 仍在，請用 /new 開新的。`
        ).catch(() => {});
        return;
      }
      // `addWorktree` is itself an await, so `/end` or shutdown can land WHILE
      // the checkout is being built — the pre-check above cannot cover that.
      // Undo our own side effect rather than leave a checkout no record points
      // at. Failing to undo it is not fatal: it is retained (never deleted
      // without git's proof) and the startup stray-worktree scan reports it.
      const claimedDuring = this.resumeOwnershipLost(rec, opts);
      if (claimedDuring) {
        console.warn(
          `resume: ${rec.threadId} was claimed while its worktree was rebuilt (${claimedDuring}); removing it again.`
        );
        const undone = await removeWorktreeIfClean(rec.repoPath, rec.workDir, rec.branch).catch(
          () => "failed" as const
        );
        if (undone !== "removed" && undone !== "already-absent") {
          console.warn(`resume: could not remove the rebuilt worktree at ${rec.workDir} (${undone})`);
        }
        return;
      }
    }
    // Windows captures before git sees the path. The persisted JSON pathname is
    // mutable; Git proves the retained handle's validation path, while the same
    // capability and its final display path transfer to the resumed actor.
    // POSIX resumes normally without file-delivery machinery.
    //
    // Checked before STARTING it, not only before acting on its result: a root
    // capture opens a real handle and the resume behind it is a runtime RPC.
    // Neither can be recalled once issued, and both keep the single-instance
    // lock held through shutdown (see `stop()`).
    const beforeCapture = this.resumeOwnershipLost(rec, opts);
    if (beforeCapture) {
      console.warn(`resume: not capturing a root for ${rec.threadId} — ${beforeCapture}`);
      return;
    }
    let captured: ValidatedRootCapture;
    try {
      captured = await this.ports.world.captureValidatedRoot({
        repoPath: rec.repoPath,
        workDir: rec.workDir,
        devMode: rec.devMode,
        branch: rec.branch,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`reconcile: transient trusted-root capture failure for ${rec.threadId}: ${msg}`);
      const abandoned = this.resumeOwnershipLost(rec, opts);
      if (!abandoned) await this.noticeTransientResumeFailure(rec.threadId, msg, opts);
      return;
    }
    if (!captured.ok) {
      console.warn(`reconcile: refusing to resume ${rec.threadId} — ${captured.verdict.detail}`);
      const abandoned = this.resumeOwnershipLost(rec, opts);
      if (abandoned) {
        console.warn(`resume: not persisting a binding refusal for ${rec.threadId} — ${abandoned}`);
        return;
      }
      if (!this.store.setState(rec.threadId, "blocked", `binding-${captured.verdict.problem}`)) {
        throw new FatalReconcileError(`reconcile: could not persist blocked state for ${rec.threadId}`);
      }
      this.releaseLocalLease(rec.threadId);
      await this.notice(
        rec.threadId,
        `⚠️ 無法復原：${describeBindingProblem(captured.verdict.problem)}。請用 /new 開新的。`
      ).catch(() => {});
      return;
    }
    const trustedRoot = captured.trustedRoot;
    const workDir = captured.binding.workDir;
    const approvalKey = captured.approvalKey;
    let runtime: ResumedRuntime;
    // Last gate before the longest, least recallable await in this method.
    const beforeCreate = this.resumeOwnershipLost(rec, opts);
    if (beforeCreate) {
      console.warn(`resume: not creating a session for ${rec.threadId} — ${beforeCreate}`);
      // The capability is open and nothing is going to take it over. Every other
      // way out of this method after a successful capture either hands it to an
      // actor (which owns it from then on, including closing it when
      // `SessionActor.create` itself fails) or closes it; this path is the one
      // that used to just return, leaving a Windows root handle held for the
      // life of the process against a worktree nobody is using.
      await captured.trustedRoot?.close().catch(() => {});
      return;
    }
    try {
      // Back into the SAME directory this session was created in — resuming a
      // worktree session into another tree would run one thread's conversation
      // against another thread's files.
      runtime = await this.ports.world.resumeActor(rec, {
        workDir,
        approvalKey,
        ...(trustedRoot ? { trustedRoot } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // `SessionActor.create` is the longest await in this method; a shutdown
      // can easily complete inside it. Nothing below may run on behalf of a
      // process that has surrendered its state.
      const abandoned = this.resumeOwnershipLost(rec, opts);
      if (abandoned) {
        console.warn(`resume: dropping the resume failure for ${rec.threadId} (${msg}) — ${abandoned}`);
        return;
      }
      if (classifyResumeError(msg) === "session-lost") {
        // Definitive: the session id is gone. Mark terminal; a failed persist of
        // that transition is a disk problem we must surface (fail startup).
        // Terminal ⇒ the repo it held in local mode is free again.
        if (!this.store.setState(rec.threadId, "orphaned", "session-lost")) {
          throw new FatalReconcileError(`reconcile: could not persist orphaned state for ${rec.threadId}`);
        }
        this.releaseLocalLease(rec.threadId);
        await this.notice(rec.threadId, "⚠️ 無法復原（session 已遺失）。請用 /new 開新的。").catch(() => {});
      } else {
        // Transient (network/RPC/unknown): leave the record ACTIVE so the next
        // restart retries. Do NOT lie that it's blocked. The thread is un-resumed
        // for THIS boot; the bot still comes up so /new remains usable.
        console.warn(`reconcile: transient resume failure for ${rec.threadId}: ${msg}`);
        await this.noticeTransientResumeFailure(rec.threadId, msg, opts);
      }
      return;
    }
    // A resumed thread was already named by the run that created it — never
    // re-title it from whatever the user happens to type first after a restart.
    //
    // Everything above this point awaited git and the runtime, and the retry
    // loop runs those awaits while `/end` and shutdown are live. Re-prove
    // ownership of the exact record we resumed BEFORE registering it: from here
    // to `registerResumedSession` there is no await, so this check and the
    // registration are one atomic step that a concurrent command cannot slip
    // inside.
    const lost = this.resumeOwnershipLost(rec, opts);
    if (lost) {
      await this.discardResumedActor(rec, runtime.actor, lost, opts);
      return;
    }
    // Make the record say "recovered" BEFORE registering the session, and treat
    // a failed write as a failed resume. `commit()` is persist-first, so a false
    // return means the record on disk (and in memory) still says
    // `thread-no-access` — registering anyway would put a live session behind a
    // durable record that denies it exists, which is the same "live session with
    // no usable record" hazard the `/end` handshake exists to prevent. The
    // record and its lease are left exactly as they were, so the next wake-up
    // (or the next boot) simply tries again.
    if (!this.store.commit(rec.threadId)) {
      console.error(
        `reconcile: could not persist the recovered state for ${rec.threadId} at ${this.store.path()}; ` +
          `discarding the resumed session and leaving the record for a later retry.`
      );
      await this.discardResumedActor(
        rec,
        runtime.actor,
        "the recovered state could not be written to disk",
        opts
      );
      await this.noticeTransientResumeFailure(rec.threadId, "無法寫入磁碟更新 session 記錄", opts);
      return;
    }
    this.ports.world.registerResumedSession(rec, runtime, workDir);
    await this.notice(
      rec.threadId,
      (opts.via === "access-retry"
        ? "♻️ Discord 存取權已恢復，已復原此對話（歷史保留）。"
        : "♻️ 已從重啟復原此對話（歷史保留）。") +
        "上一個回合已中斷且**不會自動續跑**；" +
        "先前若有指令可能已部分或完全執行，請先確認 repo／程序狀態，再決定是否重送。" +
        "\n🛡️ YOLO 模式已重置為 **OFF**（不會跨重啟保留）。"
    ).catch(() => {});
  }

  /**
   * Why a just-resumed session must NOT be registered, or `undefined`.
   *
   * Every one of these means something else won the record while the resume was
   * in flight, and registering anyway would either double-register a thread or
   * resurrect a record its owner deliberately cleared. `/end` and shutdown are
   * both allowed to win outright; this is how they do it without having to
   * cancel work they cannot see.
   */
  private resumeOwnershipLost(rec: SessionRecord, opts: ReconcileAttemptOpts = {}): string | undefined {
    if (this.shuttingDown) return "shutdown started";
    // ONE question, asked of the thing that knows: shutdown and an explicit
    // `/end` claim on this thread are both answered here. `/end` claims several
    // awaits BEFORE it removes the record, so without this the resume would win
    // a race it has already lost and leave a live session no record points at.
    const lost = opts.scope?.lostReason();
    if (lost) return lost;
    // A runtime from an earlier attempt that we could not prove stopped may
    // still hold this working tree. Registering a second one over it is exactly
    // what the barrier exists to prevent, so this is a hard refusal even though
    // the tick already checks it — the tick's check is several awaits old here.
    if (opts.scope?.obligation(runtimeObligationKey(rec.threadId))?.retained) {
      return "an earlier resume for this thread was never confirmed stopped";
    }
    if (this.hasSession(rec.threadId)) return "another session is already registered for this thread";
    const now = this.store.get(rec.threadId);
    if (!now) return "the durable record was removed (/end)";
    if (now.state !== "active") return `the record is now ${now.state}${now.reason ? ` (${now.reason})` : ""}`;
    if (now.sessionId !== rec.sessionId || now.generation !== rec.generation) {
      return "the record now points at a different session/generation";
    }
    return undefined;
  }

  /**
   * The "couldn't resume it this time" notice, told truthfully per caller.
   *
   * On the startup path this is one message per boot and a restart really is
   * what retries it. On the retry path neither half held: the loop wakes up
   * again on its own — so "restart the bot" is wrong — and it wakes up
   * repeatedly, so posting each time turns a slow recovery into an
   * indefinite drip of identical warnings in the thread. It is posted ONCE per
   * thread per process instead, and says what will actually happen.
   */
  private async noticeTransientResumeFailure(
    threadId: string,
    msg: string,
    opts: { via?: "startup" | "access-retry" }
  ): Promise<void> {
    if (opts.via !== "access-retry") {
      await this.notice(
        threadId,
        `⚠️ 暫時無法復原此對話（${msg}）。session 記錄已保留——重新啟動 bot 可再嘗試復原；或用 /new 重新開始。`
      ).catch(() => {});
      return;
    }
    if (this.accessRetryNoticed.has(threadId)) return;
    this.accessRetryNoticed.add(threadId);
    await this.notice(
      threadId,
      `⚠️ 已可存取這個討論串，但暫時無法復原對話（${msg}）。session 記錄已保留，**會自動持續重試**` +
        "（不必重啟；之後不會再重複貼這則訊息）。"
    ).catch(() => {});
  }

  /**
   * Throw away a session we resumed but may not register.
   *
   * A confirmed disconnect ends it: the runtime is gone and the object can be
   * dropped. An UNCONFIRMED one may not be, and simply logging it was the bug —
   * dropping the last reference releases the Windows root capability that is
   * the only fence stopping a possibly-live runtime from being handed a renamed
   * or deleted working tree.
   *
   * It is deliberately NOT handed to the stale-rebind companion machinery. That
   * writes a SECOND durable claim on one worktree, and here the main record is
   * usually still present and still naming this exact session — two claimants
   * would let one of them delete the tree the other still points at. Instead it
   * becomes a lifecycle OBLIGATION carrying the actor itself, which is what
   * keeps the root capability alive, gates the lock, and is retried by `/end`,
   * by the next retry attempt and by shutdown's sweep.
   */
  async discardResumedActor(
    rec: SessionRecord,
    actor: SessionActor,
    why: string,
    opts: ReconcileAttemptOpts = {}
  ): Promise<void> {
    console.warn(`resume: discarding the resumed session for ${rec.threadId} — ${why}`);
    const scope = opts.scope;
    if (!scope) {
      // NOT startup — startup owns a scope per record now, and every production
      // caller passes one. This is the defensive tail for a caller that does
      // not, and it can only ever be best effort: with no scope there is
      // nothing to hand an obligation to, so an unconfirmed runtime here is
      // reported and left to the next boot rather than silently believed.
      await withTimeout(actor.disconnect(), this.resumeTeardownTimeoutMs).catch(() => {
        console.warn(`resume: could not confirm the discarded runtime for ${rec.threadId} stopped.`);
      });
      return;
    }
    const key = runtimeObligationKey(rec.threadId);
    // First-wins is right about which runtime OWNS the key, and wrong as an
    // answer for the loser: `retain` would hand back the older handle and this
    // actor — a real, possibly-live SDK session — would be dropped with nobody
    // holding it. It gets its own key instead, so it is disconnected and, if that
    // cannot be confirmed, retained and gating the lock like any other.
    const primaryTaken = scope.obligation(key)?.retained === true;
    const ownKey = primaryTaken ? this.supersededRuntimeKey(rec.threadId) : key;
    if (primaryTaken) {
      console.warn(
        `resume: ${rec.threadId} already has an unconfirmed runtime; retaining this second one ` +
          `separately under ${ownKey} rather than dropping it.`
      );
    }
    const handle = scope.retain(ownKey, {
      describe: () => `a resumed runtime for ${rec.threadId} over ${rec.workDir}`,
      attempt: () => confirmStopped(actor.disconnect(), this.resumeTeardownTimeoutMs, () => handle),
    });
    if (!(await handle.attempt())) {
      console.warn(
        `resume: could not confirm the discarded runtime for ${rec.threadId} stopped; ` +
          `retaining it as a barrier over ${rec.workDir} until a retry or restart confirms it.`
      );
    }
  }
}

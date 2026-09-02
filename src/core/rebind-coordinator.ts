import { randomUUID } from "node:crypto";
import path from "node:path";
import { describeBindingProblem, type Binding, type DevMode, type ValidatedRootCapture } from "./binding.js";
import { PendingInteractionBroker } from "./broker.js";
import {
  withTimeout,
  type ObligationHandle,
  type TeardownOutcome,
  type TeardownScope,
} from "./lifecycle-ownership.js";
import type { SessionIdentity, SessionRecord, SessionStore } from "./session-store.js";
import type { Session } from "./session.js";
import type { TrustedRoot } from "./secure-open.js";
import type { SessionActor } from "../copilot/session-actor.js";
import {
  addWorktree,
  inspectWorktree,
  pruneWorktrees,
  removeWorktreeIfClean,
  worktreeBranch,
  worktreeOutcomeText,
  worktreePath,
} from "./worktree.js";

/** What every phase of a rebind transaction says when it discovers the thread
 *  was ended (by `/end` or by a shutdown) while it was awaiting. Shared so the
 *  phases cannot drift into telling the operator two different stories about
 *  the same outcome. */
const REBIND_ENDED = "⚠️ 這個討論串已結束，改綁已取消。";

/** Where a detached rebind incarnation is recorded. Keyed by its DURABLE
 *  identity, not by thread: one thread can legitimately have two of them, and
 *  first-wins must not drop the older unproven one. */
const staleRebindObligationKey = (b: SessionRecord): string =>
  `stale-rebind:${b.threadId}:${b.sessionId}:${b.generation}`;

/** Fallback-primary reconciliation is needed only when terminal stale ownership
 * could not persist. The target is the exact `creating` reservation retained
 * as the crash-surviving barrier; thread id alone would let a later rebind
 * restore or remove the wrong incarnation. */
interface FallbackPrimaryReconciliationPlan {
  expectedTarget: SessionIdentity;
  /** A failed rebind restores this immutable snapshot only while its original
   * actor is still the current, non-ended session. `/end` flips this to remove
   * before it awaits any teardown, so a late retry cannot resurrect it. */
  action: "restore" | "remove";
  original?: SessionRecord;
  canRestore?: () => boolean;
  /** Drops the pre-swap `/end` routing marker only after the primary restore
   * is durable, so a later `/end` reclaims the restored primary row normally. */
  afterRestore?: () => void;
  resumeFileDelivery?: () => void;
}

/** One old SDK incarnation detached by a rebind. The actor remains strongly
 * referenced until its disconnect resolves, because its retained trusted root
 * is the Windows rename/delete fence for the worktree it was using.
 *
 * Exported READ-ONLY-in-spirit: the ownership tests assert that everything this
 * coordinator still strongly references is also something the lifecycle
 * coordinator is owed, and they can only do that by naming the durable binding. */
export interface StaleRebindActor {
  actor: SessionActor;
  /** Discord thread whose lifecycle owns this detached incarnation. */
  threadId: string;
  /** Immutable durable identity and the exact old binding/worktree to clean. */
  binding: SessionRecord;
  /** Runs only after a confirmed disconnect; it rechecks worktree safety before
   * deleting anything, then removes the paired terminal store record. */
  cleanupPlan: () => Promise<{ ok: boolean; tail: string }>;
  /** Present only when the primary target reservation had to stand in for a
   * stale row that could not be written. Ownership stays retained until this
   * conditional plan durably completes. */
  fallbackPrimary?: FallbackPrimaryReconciliationPlan;
  /** Concurrent `/end`, normal rebind completion and shutdown must join ONE
   * teardown attempt rather than issue duplicate SDK disconnects. */
  disconnecting?: Promise<StaleRebindTeardown>;
  /** The ownership obligation this incarnation gates the process lock with. Kept
   * here so whichever path finally confirms the runtime stopped can discharge it
   * by identity, rather than leaving the coordinator holding the lock for a
   * runtime that has in fact been proved gone. */
  obligation?: ObligationHandle;
}

export interface StaleRebindTeardown {
  confirmed: boolean;
  /** A confirmed SDK disconnect is not enough to claim completion: the
   * worktree and durable ownership row must also be reconciled. */
  cleaned: boolean;
  tail: string;
}

/** The fixed target of one rebind, exactly as the confirmation card approved
 *  it. Carried as ONE value so no phase can re-derive a different repo or dev
 *  mode than the operator confirmed. */
export interface RebindTarget {
  repoPath: string;
  devMode: DevMode;
}

/** A rebind phase either hands the transaction its next value or ends the whole
 *  transaction with the exact message the operator is shown. A stop is never an
 *  exception: every one of them is a sentence some rollback already earned. */
type RebindStep<T> = { ok: true; value: T } | { ok: false; message: string };

/** A phase that produces nothing for the next one: `undefined` continues, a
 *  string ends the transaction with that message. */
type RebindStop = string | undefined;

/**
 * The one state value a rebind transaction carries between its phases.
 *
 * It holds three different kinds of thing, and the difference is the whole
 * reason this is a single value rather than a bag of parameters:
 *
 *  - the FIXED inputs (`threadId`, `target`, `scope`, the exact old `session`
 *    object and its snapshot). Decided once, before the first await, and never
 *    re-derived — re-reading the live map mid-transaction is precisely how a
 *    phase ends up acting on a session it no longer owns.
 *  - the FENCES (`ownsOldSession`, `endedByCommand`, `restoreOldFileDelivery`).
 *    Closures built in the first phase, so the `lostToOperator` latch and the
 *    file-delivery fence are the SAME ones for every later phase and for the
 *    shared rollback. Two copies of that latch would answer differently.
 *  - the ROLLBACK OBLIGATIONS, which are mutable. Each phase records what it
 *    actually created; that is what lets `abandonRebind` stay one method that
 *    disposes exactly what exists, instead of one rollback per phase boundary.
 */
interface RebindTransaction {
  readonly threadId: string;
  readonly target: RebindTarget;
  readonly scope: TeardownScope;
  /** The exact session object being replaced. Identity, never thread id: the
   *  map entry can be swapped underneath this transaction. */
  readonly session: Session;
  /** Immutable snapshot of the old session, for the lease restore and for the
   *  retained-worktree notice that is read AFTER the map swap. */
  readonly old: Session;
  readonly branch: string | undefined;
  /** Where the target checkout is asked for. The PROVEN display path comes back
   *  from the capture phase and is what gets persisted and handed to the SDK. */
  readonly requestedWorkDir: string;
  /** May this transaction still install what it is building? */
  readonly ownsOldSession: () => boolean;
  /** Lost to an explicit `/end` rather than to a shutdown. */
  readonly endedByCommand: () => boolean;
  /** Lift the pre-transaction file-delivery fence, but only while this
   *  transaction still owns the old session. */
  readonly restoreOldFileDelivery: () => void;
  createdWorktree: boolean;
  /** A live OS capability on Windows. Whoever holds it must close it or hand it
   *  to `SessionActor.create`; dropping the reference keeps the root fenced for
   *  the rest of the process's life. */
  trustedRoot?: TrustedRoot;
  targetLeaseHeld: boolean;
  reservedIdentity?: { sessionId: string; generation: number };
  /** The primary record this transaction moved aside, kept for the rollback
   *  that has to put it back. Set only once `reserve()` has actually replaced
   *  the thread slot, so `abandonRebind` cannot "restore" something that was
   *  never displaced. */
  restorablePrevious?: SessionRecord;
  /** The replacement runtime while THIS transaction still owns it. Cleared at
   *  the map swap, where ownership passes to the live-session map. */
  replacementActor?: SessionActor;
  replacementBinding?: SessionRecord;
  oldStale?: StaleRebindActor;
}

/** What the capture phase proved. `workDir` is the display path git accepted,
 *  not the one that was requested, and it is what gets persisted. */
interface RebindTargetCapture {
  workDir: string;
  approvalKey: string;
}

/** The durable identity reserved for the replacement, and the record it
 *  displaced. Returned as one value because every later phase's rollback needs
 *  the exact triple to CAS against. */
interface RebindReservation {
  sessionId: string;
  generation: number;
  /** The primary record `reserve()` displaced — the only snapshot a rollback
   *  may restore. */
  previous: SessionRecord;
  /** Carried forward from `previous`: a rebind replaces the SDK conversation,
   *  not the Discord thread that owns the outbound file quota. */
  fileDeliveryBytes: number;
}

/** The replacement runtime, built but not yet owning the thread. */
interface RebindReplacement {
  actor: SessionActor;
  broker: PendingInteractionBroker;
}

/** Everything the host must settle to build the replacement runtime. The host
 *  spreads its own model/transport/policy/skills/quota options onto this, so a
 *  rebind can never load a different actor configuration than `/new` or resume. */
export interface RebindReplacementActorInput {
  threadId: string;
  workDir: string;
  approvalKey: string;
  broker: PendingInteractionBroker;
  /** Ownership TRANSFERS to the host: `SessionActor.create` must either take it
   *  or close it, including on every throw. */
  trustedRoot?: TrustedRoot;
  sessionId: string;
  generation: number;
  fileDeliveryBytes: number;
}

/** The lifecycle seam. A rebind IS a teardown-and-replace of one thread's
 *  session, so it runs as a teardown claim; `LifecycleOwnership` remains the
 *  only lock-release authority and this coordinator merely runs inside it. */
export interface RebindProcessPort {
  runTeardown<T>(
    threadId: string,
    body: (scope: TeardownScope) => Promise<T>
  ): Promise<TeardownOutcome<T>>;
}

/** The durable and in-memory bookkeeping the host owns and this coordinator
 *  reads, installs into, and rolls back. */
export interface RebindInventoryPort {
  /** Read late: a test may hand the app a different store than the one that
   *  existed when this coordinator was constructed. */
  store(): SessionStore;
  session(threadId: string): Session | undefined;
  /** Install the replacement as this thread's live session. Synchronous: the
   *  commit and this swap are one atomic step with no suspension between them. */
  installSession(threadId: string, session: Session): void;
  /** Has an explicit teardown claimed this exact session object? */
  isEnded(session: Session): boolean;
  acquireLocalLease(repoPath: string, threadId: string): { ok: true } | { ok: false; holder: string };
  /** Drop whatever lease `threadId` holds. */
  releaseLocalLease(threadId: string): void;
  /** Drop the lease on ONE repo, and only while `threadId` still holds it —
   *  after the map swap the target lease belongs to the replacement, not to a
   *  rollback. */
  releaseLocalLeaseHeldBy(repoPath: string, threadId: string): void;
  localHolder(repoPath: string): string | undefined;
}

/** Everything outside this coordinator's own bookkeeping: the binding proof,
 *  the worktree root, the runtime factory and the approval memory. */
export interface RebindWorldPort {
  /** The shared capture-and-prove helper `/new` and resume also use. */
  captureValidatedRoot(binding: Binding): Promise<ValidatedRootCapture>;
  /** Where per-session worktrees live, read late for the same reason the app
   *  reads it late: it is half of a security boundary several validators derive
   *  independently. */
  worktreeRoot(): string;
  /** The guild every durable record is written under. Read late, like every
   *  other port here, so no port can freeze a collaborator a test replaced. */
  guildId(): string;
  createReplacementActor(input: RebindReplacementActorInput): Promise<SessionActor>;
  /** Session-scoped approvals are grants for THIS conversation in THIS repo. */
  clearSessionApprovals(threadId: string): void;
  /** Bound on ONE runtime teardown attempt. */
  runtimeTeardownTimeoutMs: number;
}

export interface RebindHostPorts {
  process: RebindProcessPort;
  inventory: RebindInventoryPort;
  world: RebindWorldPort;
}

/**
 * What `/end` may ask of an in-flight or already-detached rebind, claimed
 * SYNCHRONOUSLY before `/end`'s first await.
 *
 * It exists as one claim rather than five reach-ins because `/end` and a rebind
 * race over the same three facts — which durable row describes the OLD
 * incarnation, whether a failed rebind's fallback plan may still restore it,
 * and which actors this thread has detached — and every one of those has to be
 * decided at the same instant, before anything is awaited.
 */
export interface RebindEndClaim {
  /** `/end` could not confirm the current runtime stopped. Retain the pending
   *  old incarnation as an owned barrier and retry every detached actor. */
  retainUnconfirmed(scope: TeardownScope): Promise<void>;
  /**
   * The current runtime IS confirmed stopped: settle the pre-swap companion, if
   * this thread had one, and every other incarnation it detached.
   *
   * `undefined` means there was no companion — the thread's own record is the
   * ordinary one `/end` reclaims. Answering with a value rather than a boolean
   * flag plus a second call is what keeps "no companion" from being spellable
   * as a settled-and-clean outcome nobody actually proved.
   */
  settlePendingOld(): Promise<(StaleRebindTeardown & { fallbackPending: boolean }) | undefined>;
}

/**
 * The repo-rebind transaction and ALL of the state it owns.
 *
 * The host is the inbound adapter: it owns the Discord confirmation card, the
 * live-session map, the local leases, the store, the binding/capture helper and
 * the actor options that `/new` and resume share. This owns the transaction —
 * its preconditions, its nine phases, the one rollback they share — and the
 * three pieces of state that exist only because a rebind can fail halfway: the
 * per-thread admission set, the detached incarnations this process could not
 * prove stopped, and the pre-swap companion `/end` has to finish.
 *
 * `LifecycleOwnership` remains the only lock-release authority; every retained
 * incarnation here is registered as an obligation against it.
 */
export class RebindCoordinator {
  /** Threads with a rebind in progress. Two `apply` runs on one thread would
   *  each create a session and each install it, leaving the loser's SDK session
   *  live but referenced by nothing. */
  private readonly rebinding = new Set<string>();
  /** Detached rebind incarnations, whether the detached actor was the old
   * session after a swap or a replacement that lost the race before install.
   * Each entry has a paired durable `blocked` stale-rebind record. Keeping this
   * map strongly owns its actor/root until disconnect is confirmed; otherwise
   * a GC-released root could let a possibly-live runtime write a renamed or
   * deleted worktree. */
  private readonly staleRebindActors = new Map<SessionActor, StaleRebindActor>();
  /** An old incarnation is made durable before rebind overwrites its main
   * thread record. `/end` can arrive while target creation is still suspended;
   * this lets that winner terminalize the OLD binding instead of leaving the
   * target reservation as the only on-disk pointer. */
  private readonly pendingRebindOlds = new WeakMap<Session, StaleRebindActor>();

  constructor(private readonly ports: RebindHostPorts) {}

  private get store(): SessionStore {
    return this.ports.inventory.store();
  }

  // ------------------------------------------------------------- the command --

  /**
   * Everything that must be true for a rebind, or a message saying what is not.
   *
   * Called BOTH before the confirmation is shown and again after the click,
   * because every one of these can change while a button sits on screen: a plain
   * message starts a turn (`onMessage`), `/queue` starts one when idle, and
   * another thread can take the local lease.
   */
  async blockers(threadId: string, session: Session, target: RebindTarget): Promise<string | undefined> {
    if (this.hasUnreconciledFallback(threadId)) {
      return "⚠️ 前一次改綁的安全屏障仍在清理／對帳中。為避免把目標建立預留誤認為舊 session，請稍後再試。";
    }
    // The in-memory tracker is intentionally not restart-durable: it owns a
    // local actor/root. If a process ends before reconciliation, the retained
    // primary `creating` row is still a fail-closed barrier rather than a valid
    // predecessor for another rebind.
    if (this.store.get(threadId)?.state === "creating") {
      return "⚠️ 這個討論串有未完成的 session 建立預留，無法安全改綁。請先處理／結束該預留後再試。";
    }
    if (session.running) {
      return "⏳ 這個 session 正在執行中。請等它結束，或先用 `/stop`，再改綁。";
    }
    if (session.queue.length) {
      return `⏳ 佇列中還有 ${session.queue.length} 則訊息。請先 \`/queue clear:true\`，或等它跑完。`;
    }
    if (target.devMode === "local") {
      const holder = this.ports.inventory.localHolder(target.repoPath);
      if (holder !== undefined && holder !== threadId) {
        return (
          `🔒 \`${path.basename(target.repoPath)}\` 已經被 <#${holder}> 以 local 模式佔用。\n` +
          "同一個 repo 同時只能有一個 local session——兩個 agent 改同一份 checkout 會互相覆蓋，" +
          "其中一個 `git checkout` 就會毀掉另一個未提交的工作。請改用 `worktree` 模式，或先結束那個討論串。"
        );
      }
    }
    // The CURRENT worktree is about to be left behind. Refuse rather than orphan
    // it: after a rebind nothing points at it any more — `/end` acts on the
    // session's NEW binding — so a tree with uncommitted work would become
    // unreachable from every command.
    if (session.devMode === "worktree" && session.branch) {
      const condition = await inspectWorktree(session.workDir, session.branch);
      if (condition === "dirty") {
        return (
          `🌿 目前的 worktree \`${session.workDir}\` 還有未提交／未追蹤／被忽略的內容。\n` +
          "改綁之後就沒有任何記錄指向它了，所以這裡不動它。請先 commit／push 或自行處理後再試。"
        );
      }
      if (condition === "detached") {
        return (
          `🌿 目前 worktree 的 HEAD 不是 \`${session.branch}\`（detached 或換了分支），` +
          "裡面可能有沒有任何分支指向的 commit。請自行確認後再改綁。"
        );
      }
      if (condition === "unknown") {
        return "🌿 無法確認目前 worktree 是否乾淨（git 沒有回應），為安全起見不改綁。";
      }
    }
    return undefined;
  }

  /**
   * Perform the rebind, in the order that leaves nothing stranded on any failure.
   *
   * Mirrors the discipline in `cmdNew` and `reclaim`: prepare the new resource
   * before touching the old one, persist before creating, and keep a fence
   * rather than lose track of a runtime that might still be live.
   *
   *  1. re-check everything (the pre-click checks are stale by now)
   *  2. build the TARGET worktree — the old one is not touched yet
   *  3. prove the new binding with git before an agent is pointed at it
   *  4. reserve the new record durably
   *  5. create the new SDK session
   *  6. commit, swap the in-memory session, take/release the local lease
   *  7. disconnect the old actor (report honestly if that cannot be confirmed)
   *  8. only now let go of the old worktree
   */
  async apply(threadId: string, target: RebindTarget): Promise<string> {
    // One rebind per thread at a time. Everything below is a long chain of
    // awaits (git subprocesses, then an SDK create), and two runs would each
    // build a worktree, each reserve+commit over the other's record, and each
    // install a session — after which the loser's SessionActor is live,
    // referenced by nothing, invisible to `stop()`, holding a worktree the store
    // does not mention. Mirrors the `creating` guard on `/new`.
    if (this.rebinding.has(threadId)) {
      return "⏳ 這個討論串已經有一個改綁在進行中，這次沒有執行。";
    }
    this.rebinding.add(threadId);
    try {
      // A rebind IS a teardown-and-replace of one thread's session: it stops the
      // old runtime, may leave a detached incarnation nobody proved stopped, and
      // decides the fate of a worktree. Running it as a lifecycle teardown claim
      // is what lets it record that incarnation as an ownership obligation, and
      // what makes the access-retry loop decline this thread for the duration —
      // a retry resuming into a thread mid-rebind is the same hazard `/end`
      // already guards. The claim is counted, so a nested `/end` is safe.
      const outcome = await this.ports.process.runTeardown(threadId, (scope) =>
        this.applyInner(threadId, target, scope)
      );
      // Declined ⇒ shutdown began. Starting a rebind then would build an SDK
      // session and a worktree that the armed teardown has already walked past.
      return outcome.ran ? outcome.value : "⚠️ bot 正在關閉中，這次沒有改綁。";
    } finally {
      this.rebinding.delete(threadId);
    }
  }

  // --------------------------------------------- what other lifecycles ask --

  /** Is any detached incarnation for this thread still holding a target
   *  reservation that its conditional reconciliation could not settle? */
  hasUnreconciledFallback(threadId: string): boolean {
    return [...this.staleRebindActors.values()].some(
      (entry) => entry.threadId === threadId && entry.fallbackPrimary !== undefined
    );
  }

  /** Does this process still strongly own a detached incarnation for this
   *  thread — i.e. a runtime it could not prove stopped? */
  hasDetachedIncarnations(threadId: string): boolean {
    return [...this.staleRebindActors.values()].some((entry) => entry.threadId === threadId);
  }

  /** Explicit cleanup (and shutdown) is per owning Discord thread, not merely
   * per current map entry: after a map swap there can be both a replacement and
   * its old incarnation. */
  async settleDetached(threadId: string): Promise<void> {
    const entries = [...this.staleRebindActors.values()].filter((entry) => entry.threadId === threadId);
    for (const entry of entries) await this.retryStaleRebindActor(entry.actor);
  }

  /** Rebind replacements that lost ownership during `/end` are intentionally
   * not in the live-session map, but may still hold a Windows root fence. Give
   * each one the same bounded shutdown retry; a failed retry remains retained
   * until process exit rather than being silently dropped. */
  async sweepDetachedOnShutdown(): Promise<void> {
    for (const actor of [...this.staleRebindActors.keys()]) {
      await withTimeout(
        this.retryStaleRebindActor(actor),
        this.ports.world.runtimeTeardownTimeoutMs
      ).catch(() => {});
    }
  }

  /** Everything this coordinator still strongly references. Read-only, and the
   *  ownership suites' only honest way to assert the invariant that binds this
   *  map to the lifecycle coordinator's obligations. */
  detachedIncarnations(): ReadonlyMap<SessionActor, StaleRebindActor> {
    return this.staleRebindActors;
  }

  /**
   * Reap terminal companion rows this thread left behind, once no detached
   * actor still owns any of them.
   *
   * `/end` reaches this only after `settleDetached` has proved this process
   * holds no live incarnation for the thread, which is why these rows may be
   * removed outright: the rule they still obey is the one this coordinator
   * never relaxes — git must prove the worktree removable before it is deleted.
   */
  async reclaimAbandonedRecords(
    bindings: readonly SessionRecord[]
  ): Promise<Array<{ ok: boolean; tail: string }>> {
    const outcomes: Array<{ ok: boolean; tail: string }> = [];
    for (const binding of bindings) outcomes.push(await this.reclaimStaleRebind(binding, true));
    return outcomes;
  }

  /**
   * `/end` claims this thread's rebind state, synchronously.
   *
   * Both mutations happen before the caller's first await, on purpose: `/end`
   * wins from its first instruction, so a fallback tracker created by a failed
   * rebind must remove its exact target reservation rather than restore a
   * record the operator has just given up, and the pre-swap companion must be
   * read while it is still unambiguously this session's.
   */
  claimEnd(threadId: string, session: Session): RebindEndClaim {
    // A replacement whose stale row could not persist may be held solely by a
    // target `creating` reservation. Change its retry plan before the first
    // await: `/end` wins, so a later confirmed replacement teardown may remove
    // that exact reservation but must never restore this session's record.
    this.markFallbackPrimaryEnded(threadId);
    // Once rebind has reserved its durable old-incarnation companion, `/end`
    // must finish that companion rather than treating the mutable main record
    // (which may already be the target reservation) as if it described this
    // old actor.
    const pendingOld = this.pendingRebindOlds.get(session);
    return {
      retainUnconfirmed: async (scope: TeardownScope): Promise<void> => {
        if (pendingOld) {
          this.retainStaleRebindActor(pendingOld, "rebind-teardown-unconfirmed", undefined, scope);
        }
        // A replacement can have been swapped in before this `/end`; it does not
        // excuse the old incarnation from cleanup merely because ending the
        // replacement timed out too.
        await this.settleDetached(threadId);
      },
      settlePendingOld: async (): Promise<
        (StaleRebindTeardown & { fallbackPending: boolean }) | undefined
      > => {
        if (!pendingOld) return undefined;
        this.pendingRebindOlds.delete(session);
        // The rebind's target reservation/worktree belongs to its own rollback
        // path. Reclaiming by thread id here would delete or retire that target
        // row and lose the exact old pointer we just proved stopped. The
        // companion cleanup owns only the old incarnation.
        const tracked = this.staleRebindActors.get(pendingOld.actor) === pendingOld;
        let outcome: StaleRebindTeardown;
        if (tracked) {
          outcome = await this.disconnectStaleRebindActor(pendingOld);
        } else {
          const cleanup = await pendingOld.cleanupPlan();
          outcome = { confirmed: true, cleaned: cleanup.ok, tail: cleanup.tail };
        }
        // A failed pre-swap replacement may already be tracked behind the target
        // primary reservation. `/end` changed its plan to removal above; retry it
        // now that the command has won, rather than leaving an already-confirmed
        // target actor waiting for some unrelated later lifecycle event.
        await this.settleDetached(threadId);
        return { ...outcome, fallbackPending: this.hasUnreconciledFallback(threadId) };
      },
    };
  }

  // ---------------------------------------------- detached-incarnation state --

  /** Build the one ownership object shared by normal rebind completion, `/end`
   * and shutdown. The durable record is made before the main record is
   * overwritten; this in-memory entry keeps the actor's trusted root fenced
   * until the same cleanup plan sees a confirmed disconnect. */
  private staleRebindActor(
    actor: SessionActor,
    binding: SessionRecord,
    preflightClean: boolean
  ): StaleRebindActor {
    const immutableBinding = { ...binding };
    let entry!: StaleRebindActor;
    entry = {
      actor,
      threadId: immutableBinding.threadId,
      binding: immutableBinding,
      // A fallback plan is installed only after the stale-row write fails.
      // Read it at cleanup time rather than capturing its initial absence:
      // otherwise a later confirmed retry would delete that row before the
      // primary fallback can be atomically reconciled.
      cleanupPlan: () =>
        this.reclaimStaleRebind(immutableBinding, preflightClean, entry.fallbackPrimary === undefined),
    };
    return entry;
  }

  private fallbackPrimaryPlan(
    target: SessionRecord,
    original?: SessionRecord,
    canRestore?: () => boolean,
    afterRestore?: () => void,
    resumeFileDelivery?: () => void
  ): FallbackPrimaryReconciliationPlan {
    return {
      expectedTarget: {
        threadId: target.threadId,
        sessionId: target.sessionId,
        generation: target.generation,
      },
      action: original ? "restore" : "remove",
      ...(original
        ? {
            original: { ...original },
            canRestore,
            afterRestore,
            resumeFileDelivery,
          }
        : {}),
    };
  }

  /** `/end` wins before it awaits either actor. Any fallback tracker created
   * by the failed rebind must therefore remove its exact target reservation,
   * never restore the old record after the command has ended it. */
  private markFallbackPrimaryEnded(threadId: string): void {
    for (const entry of this.staleRebindActors.values()) {
      const fallback = entry.fallbackPrimary;
      if (!fallback || entry.threadId !== threadId) continue;
      this.setFallbackPrimaryRemoval(fallback);
    }
  }

  /** Once `/end` owns the thread, a fallback may only remove its exact target.
   * Clear every restore-only callback before any teardown await, because a
   * retry can otherwise observe the old plan after the owner has gone away. */
  private setFallbackPrimaryRemoval(fallback: FallbackPrimaryReconciliationPlan): void {
    fallback.action = "remove";
    fallback.original = undefined;
    fallback.canRestore = undefined;
    fallback.afterRestore = undefined;
    fallback.resumeFileDelivery = undefined;
  }

  /** Persist and strongly retain an actor that has already failed a disconnect
   * attempt. The durable row uses existing `blocked` semantics, so reconcile
   * cannot accidentally resume this old conversation. Callers that would
   * otherwise remove or restore its primary reservation must use the returned
   * result as a durability gate. */
  private retainStaleRebindActor(
    entry: StaleRebindActor,
    reason: string,
    fallbackPrimary: FallbackPrimaryReconciliationPlan | undefined,
    // REQUIRED, not optional. Every real call site sits inside a teardown claim,
    // and an omission meant this coordinator kept its index entry while the
    // lifecycle coordinator learned nothing — the retained actor would then not
    // gate the lock at all. Making the compiler ask the question is the only
    // thing that keeps that true as call sites are added.
    scope: TeardownScope
  ): boolean {
    const persisted = this.store.retainStaleRebind(entry.binding, reason);
    if (!persisted) {
      // The pre-swap intent was persisted before this method is reachable for
      // an old actor. Keep the root in memory even if a reason refresh loses a
      // transient disk race; silently releasing it would be worse.
      console.warn(`rebind: could not persist stale actor ${entry.binding.sessionId} (${reason})`);
      if (fallbackPrimary) entry.fallbackPrimary = fallbackPrimary;
    }
    this.staleRebindActors.set(entry.actor, entry);
    // The same fact the retry loop's barrier records, about a different kind of
    // runtime: this process created it, cannot prove it stopped, and it may
    // still be holding a checkout. Recorded as an OBLIGATION so it gates the
    // LOCK too — shutdown used to retry these actors and then release whether or
    // not any of them had confirmed.
    //
    // The obligation carries the entry itself: actor, binding and cleanup plan
    // all live in the closure, so this is not a second barrier map beside
    // `staleRebindActors`. That map is this coordinator's index for its own
    // lifecycle work (retry, `/end`, fallback reconciliation); this is the
    // ownership fact. Kept ON THE ENTRY, so every other path that confirms this
    // runtime stopped can identity-discharge it. A handle thrown away here would
    // mean the ordinary teardown paths cleared the index while the lifecycle
    // coordinator went on holding the lock for a runtime that had in fact been
    // proved gone.
    entry.obligation = scope.retain(staleRebindObligationKey(entry.binding), {
      describe: () =>
        `a detached rebind incarnation ${entry.binding.sessionId} over ${entry.binding.workDir}`,
      attempt: async () => {
        const outcome = await withTimeout(
          this.disconnectStaleRebindActor(entry),
          this.ports.world.runtimeTeardownTimeoutMs
        ).catch(() => undefined);
        // Only a confirmed teardown WHOSE CLEANUP also completed discharges it.
        // An unconfirmed runtime, or a worktree git would not let us remove, is
        // still a reason this process may not let go.
        return outcome?.confirmed === true && outcome.cleaned;
      },
    });
    this.scheduleStaleRebindRetry(entry);
    return persisted;
  }

  private scheduleStaleRebindRetry(entry: StaleRebindActor): void {
    queueMicrotask(() => {
      if (this.staleRebindActors.get(entry.actor) === entry) {
        void this.retryStaleRebindActor(entry.actor);
      }
    });
  }

  /** Retry one actor. A concurrent normal rebind completion or `/end` joins the
   * same `disconnecting` promise below, so retry never creates competing SDK
   * teardowns for one root. */
  private async retryStaleRebindActor(actor: SessionActor): Promise<void> {
    const entry = this.staleRebindActors.get(actor);
    if (!entry) return;
    await this.disconnectStaleRebindActor(entry);
  }

  /** Complete the primary side of a fallback only after the actor is confirmed
   * gone and its worktree cleanup plan succeeded. A mismatch or write failure
   * deliberately leaves both the target barrier and this actor tracker in
   * place: neither a newer record nor a possibly-live runtime is ours to drop. */
  private reconcileFallbackPrimary(entry: StaleRebindActor): { ok: boolean; tail: string } {
    const fallback = entry.fallbackPrimary;
    if (!fallback) return { ok: true, tail: "" };

    if (fallback.action === "restore" && (!fallback.original || !fallback.canRestore?.())) {
      // This catches `/end` even if it raced immediately before this retry.
      // Removing is safe only under the target CAS; restoring is not.
      fallback.action = "remove";
      fallback.original = undefined;
      fallback.canRestore = undefined;
      fallback.afterRestore = undefined;
      fallback.resumeFileDelivery = undefined;
    }

    const targetStale: SessionIdentity = {
      threadId: entry.binding.threadId,
      sessionId: entry.binding.sessionId,
      generation: entry.binding.generation,
    };
    const result =
      fallback.action === "restore" && fallback.original
        ? this.store.reconcileFallbackPrimary(fallback.expectedTarget, {
            kind: "restore",
            original: fallback.original,
            staleRebinds: [
              targetStale,
              {
                threadId: fallback.original.threadId,
                sessionId: fallback.original.sessionId,
                generation: fallback.original.generation,
              },
            ],
          })
        : this.store.reconcileFallbackPrimary(fallback.expectedTarget, {
            kind: "remove",
            staleRebinds: [targetStale],
          });
    if (!result.ok) {
      console.warn(
        `rebind: fallback primary ${fallback.expectedTarget.sessionId} did not conditionally reconcile; retaining barrier and actor ownership`
      );
      return {
        ok: false,
        tail:
          "\n⚠️ 已確認 replacement runtime 停止，但無法安全對帳其建立預留；安全屏障與清理擁有權均保留，請稍後重試。",
      };
    }
    if (fallback.action === "restore") {
      fallback.afterRestore?.();
      if (!result.quotaAdvanced) fallback.resumeFileDelivery?.();
    }
    return { ok: true, tail: "" };
  }

  /** Make exactly one bounded disconnect attempt for a stale incarnation. On
   * success its cleanup plan rechecks the worktree before deletion; on failure
   * the `blocked` durable row and strong actor/root reference both remain. */
  private async disconnectStaleRebindActor(entry: StaleRebindActor): Promise<StaleRebindTeardown> {
    if (entry.disconnecting) return entry.disconnecting;
    const attempt = (async (): Promise<StaleRebindTeardown> => {
      try {
        await withTimeout(entry.actor.disconnect(), this.ports.world.runtimeTeardownTimeoutMs);
      } catch {
        if (!this.store.retainStaleRebind(entry.binding, "rebind-teardown-unconfirmed")) {
          console.warn(`rebind: could not mark stale actor ${entry.binding.sessionId} unconfirmed`);
        }
        this.staleRebindActors.set(entry.actor, entry);
        return {
          confirmed: false,
          cleaned: false,
          tail: "\n⚠️ 無法確認舊的 runtime 已關閉，建議稍後重啟 bot。",
        };
      }
      const cleanup = await entry.cleanupPlan();
      const fallback = cleanup.ok ? this.reconcileFallbackPrimary(entry) : { ok: true, tail: "" };
      const cleaned = cleanup.ok && fallback.ok;
      if (cleaned && this.staleRebindActors.get(entry.actor) === entry) {
        this.staleRebindActors.delete(entry.actor);
      }
      // The RUNTIME is confirmed stopped, whatever happened to the worktree, so
      // this incarnation is no longer a reason to hold the process lock. Any
      // kept tree is recorded durably and reclaimable by `/end`; identity-safe,
      // so a newer incarnation's handle is untouched.
      entry.obligation?.discharge();
      return { confirmed: true, cleaned, tail: `${cleanup.tail}${fallback.tail}` };
    })();
    entry.disconnecting = attempt;
    try {
      return await attempt;
    } finally {
      if (entry.disconnecting === attempt) entry.disconnecting = undefined;
    }
  }

  /** Reclaim the durable companion of a detached rebind incarnation. It shares
   * `/end`'s proof-before-delete rule, but never touches the main
   * thread→replacement record: the two can coexist after a map swap. */
  private async reclaimStaleRebind(
    binding: SessionRecord,
    preflightClean: boolean,
    removeRecord = true
  ): Promise<{ ok: boolean; tail: string }> {
    let tail = "";
    if (binding.branch && binding.workDir !== binding.repoPath) {
      // Rebind already refused a dirty/detached/unknown old tree. Keep the
      // captured preflight as an additional transaction fence, then ask git
      // again immediately before delete because a runtime may have written
      // between the two checks.
      if (!preflightClean) {
        const kept = this.store.retainStaleRebind(binding, "rebind-worktree-kept");
        return {
          ok: false,
          tail:
            "\n🌿 舊的 worktree **保留**：改綁前未能證明它可安全移除。" +
            (kept ? "" : "\n⚠️ 且無法寫入磁碟保留清理記錄。"),
        };
      }
      const outcome = await removeWorktreeIfClean(binding.repoPath, binding.workDir, binding.branch).catch(
        () => "failed" as const
      );
      tail = worktreeOutcomeText(outcome, binding.workDir, binding.branch);
      if (outcome !== "removed" && outcome !== "already-absent") {
        const kept = this.store.retainStaleRebind(binding, "rebind-worktree-kept");
        return {
          ok: false,
          tail:
            `${tail}\n記錄保留，\`/sessions\` 才看得到還有東西在磁碟上。` +
            (kept ? "" : "\n⚠️ 且無法寫入磁碟更新記錄，請檢查磁碟／權限。"),
        };
      }
    }
    // A fallback primary must be reconciled with this stale row in ONE store
    // mutation. Removing the stale half first would turn a later CAS/write
    // failure into an actor whose only durable barrier no longer says why it
    // exists.
    if (!removeRecord) return { ok: true, tail };
    if (!this.store.removeStaleRebind(binding.threadId, binding.sessionId, binding.generation)) {
      return {
        ok: false,
        tail: `${tail}\n⚠️ 但無法寫入磁碟移除舊 incarnation 記錄，請檢查磁碟／權限後重試。`,
      };
    }
    return { ok: true, tail };
  }

  // ------------------------------------------------------------- the phases --

  /**
   * The rebind transaction, as an ordered list of phases over ONE context.
   *
   * Each phase owns a checkpoint of the numbered order documented on `apply`:
   * it re-asks `tx.ownsOldSession()` after its own awaits, and it records on the
   * transaction whatever it created, so the shared rollback (`abandonRebind`)
   * can dispose exactly what exists at that moment. A phase that stops the
   * transaction returns the sentence the operator is shown; it never throws its
   * own control flow.
   *
   * The last step is deliberately NOT awaited here: `commitRebindTransaction`
   * hands over to the retirement of the old incarnation with no await between
   * the map swap and the ownership registration of the detached predecessor.
   */
  private async applyInner(
    threadId: string,
    target: RebindTarget,
    scope: TeardownScope
  ): Promise<string> {
    const started = await this.beginRebindTransaction(threadId, target, scope);
    if (!started.ok) return started.message;
    const tx = started.value;
    const worktree = await this.openRebindTargetWorktree(tx);
    if (worktree !== undefined) return worktree;
    const captured = await this.captureRebindTarget(tx);
    if (!captured.ok) return captured.message;
    const reserved = await this.reserveRebindTarget(tx, captured.value);
    if (!reserved.ok) return reserved.message;
    const replacement = await this.createRebindReplacement(tx, captured.value, reserved.value);
    if (!replacement.ok) return replacement.message;
    return this.commitRebindTransaction(tx, captured.value, reserved.value, replacement.value);
  }

  /**
   * Phase 1 — re-check everything, fence the old session, and build the context
   * every later phase mutates.
   *
   * The pre-click checks are stale by now, so `blockers` is asked again.
   * The file-delivery fence is taken SYNCHRONOUSLY, before that call and before
   * any git or SDK await: a stale actor must not reserve or send against the
   * replacement record while this transaction is in flight. That is why the
   * fence lives in this phase and not in the one that reserves the target —
   * moving it there would move it past an await.
   */
  private async beginRebindTransaction(
    threadId: string,
    target: RebindTarget,
    scope: TeardownScope
  ): Promise<RebindStep<RebindTransaction>> {
    const { inventory, world } = this.ports;
    const session = inventory.session(threadId);
    if (!session) return { ok: false, message: "⚠️ 這個討論串已經沒有進行中的 session，未改綁。" };
    if (inventory.isEnded(session)) return { ok: false, message: "⚠️ 這個討論串已結束，改綁未執行。" };
    /**
     * May this transaction still install what it is building?
     *
     * Every await below is already followed by a check of this predicate with
     * the rollback that is correct for THAT phase — close the captured root,
     * undo the worktree just created, restore or retain the durable
     * reservation, move the local lease back, tear the replacement actor down
     * through the retain machinery, leave the old session in the map. The gap
     * was never a missing checkpoint; it was that this predicate could not see
     * a shutdown.
     *
     * `/end` is visible through the ended set and the map, but `stop()` sets
     * its flags and then tears down asynchronously, so between those two moments
     * the old session is still mapped and un-ended — long enough for this
     * transaction to create an SDK session and a worktree, and to register them
     * AFTER `teardownResources` has already walked the map. Asking the scope
     * closes that window at every existing checkpoint at once, which is the only
     * way to add shutdown-awareness without inventing rollback that does not
     * already exist.
     */
    /** Why this transaction lost the old session, decided at the FIRST moment it
     *  is observed lost and never re-asked.
     *
     *  `endedByCommand()` reads the live map and the ended set — and shutdown's
     *  own teardown clears the map and marks every session ended. So by the time
     *  the abandon path runs, "did the operator give this conversation up?"
     *  answers YES for a process that was merely stopping, and the old primary
     *  gets removed instead of restored. Latch it while the two are still
     *  distinguishable: if the scope reports a shutdown, it was not the
     *  operator. */
    let lostToOperator: boolean | undefined;
    const ownsOldSession = (): boolean => {
      const owns =
        inventory.session(threadId) === session &&
        !inventory.isEnded(session) &&
        scope.lostReason() === undefined;
      if (!owns && lostToOperator === undefined) {
        lostToOperator = scope.lostReason() === undefined;
      }
      return owns;
    };
    /** Lost to an explicit `/end` rather than to shutdown. The distinction
     *  matters for the fallback plan below: `/end` deliberately gives up the old
     *  record, while a shutdown expects the next boot to resume it. */
    const endedByCommand = (): boolean =>
      lostToOperator ?? (inventory.isEnded(session) || inventory.session(threadId) !== session);
    // Fence old attachments synchronously, before `blockers` or any git/SDK
    // await. A stale actor must not reserve or send against the replacement
    // record while this transaction is in flight.
    const fileDeliveryFence = session.actor.suspendFileDelivery();
    const restoreOldFileDelivery = (): void => {
      if (ownsOldSession()) {
        session.actor.resumeFileDeliveryIfCurrent(fileDeliveryFence);
      }
    };
    const stale = await this.blockers(threadId, session, target);
    if (!ownsOldSession()) return { ok: false, message: REBIND_ENDED };
    if (stale) {
      restoreOldFileDelivery();
      return {
        ok: false,
        message: `${stale}\n（在你確認的這段時間內狀態改變了，因此未改綁。）`,
      };
    }

    return {
      ok: true,
      value: {
        threadId,
        target,
        scope,
        session,
        old: { ...session },
        branch: target.devMode === "worktree" ? worktreeBranch(threadId) : undefined,
        requestedWorkDir:
          target.devMode === "worktree"
            ? worktreePath(world.worktreeRoot(), target.repoPath, threadId)
            : target.repoPath,
        ownsOldSession,
        endedByCommand,
        restoreOldFileDelivery,
        createdWorktree: false,
        targetLeaseHeld: false,
      },
    };
  }

  /** Phase 2 — build the TARGET worktree. The old one is not touched yet, so
   *  every stop here only has to undo what this phase itself created. */
  private async openRebindTargetWorktree(tx: RebindTransaction): Promise<RebindStop> {
    const { branch, requestedWorkDir, target } = tx;
    if (target.devMode === "worktree" && branch) {
      try {
        await pruneWorktrees(target.repoPath);
        if (!tx.ownsOldSession()) return REBIND_ENDED;
        await addWorktree(target.repoPath, requestedWorkDir, branch);
        tx.createdWorktree = true;
        if (!tx.ownsOldSession()) {
          await removeWorktreeIfClean(target.repoPath, requestedWorkDir, branch).catch(() => "failed" as const);
          return REBIND_ENDED;
        }
      } catch (err) {
        if (!tx.ownsOldSession()) return REBIND_ENDED;
        tx.restoreOldFileDelivery();
        return `⚠️ 無法建立目標 worktree（${err instanceof Error ? err.message : String(err)}）。未改綁，原本的設定不變。`;
      }
    }
    return undefined;
  }

  /** Undo the target checkout, and only if this transaction is the thing that
   *  created it. Safe to call unconditionally for exactly that reason. */
  private async undoRebindWorktree(tx: RebindTransaction): Promise<void> {
    if (tx.createdWorktree) {
      await removeWorktreeIfClean(tx.target.repoPath, tx.requestedWorkDir, tx.branch).catch(
        () => "failed" as const
      );
    }
  }

  /** Drop the target's local lease, and only while this transaction still holds
   *  it: after the map swap it belongs to the replacement, not to a rollback. */
  private releaseRebindTargetLease(tx: RebindTransaction): void {
    if (!tx.targetLeaseHeld) return;
    this.ports.inventory.releaseLocalLeaseHeldBy(tx.target.repoPath, tx.threadId);
    tx.targetLeaseHeld = false;
  }

  /** Put the local lease back where it was after a failed rebind. */
  private restoreLeaseFor(threadId: string, previous: Session): void {
    this.ports.inventory.releaseLocalLease(threadId);
    if (previous.devMode === "local") {
      this.ports.inventory.acquireLocalLease(previous.repoPath, threadId);
    }
  }

  /** Phase 3 — prove the new binding with git before an agent is pointed at it.
   *
   *  Ends by taking ownership of the captured root: from here every stop must
   *  close it, which is why the lease and the reservation live in the next
   *  phase rather than here. */
  private async captureRebindTarget(tx: RebindTransaction): Promise<RebindStep<RebindTargetCapture>> {
    const { branch, requestedWorkDir, target } = tx;
    let captured: ValidatedRootCapture;
    try {
      captured = await this.ports.world.captureValidatedRoot({
        repoPath: target.repoPath,
        workDir: requestedWorkDir,
        devMode: target.devMode,
        branch,
      });
    } catch (err) {
      if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
      tx.restoreOldFileDelivery();
      await this.undoRebindWorktree(tx);
      return {
        ok: false,
        message: `⚠️ 無法安全開啟目標工作目錄（${err instanceof Error ? err.message : String(err)}）。未改綁。`,
      };
    }
    if (!tx.ownsOldSession()) {
      if (captured.ok) tx.trustedRoot = captured.trustedRoot;
      return { ok: false, message: await this.abandonRebind(tx) };
    }
    if (!captured.ok) {
      tx.restoreOldFileDelivery();
      await this.undoRebindWorktree(tx);
      return {
        ok: false,
        message: `⚠️ 目標綁定無法通過驗證（${describeBindingProblem(captured.verdict.problem)}：${captured.verdict.detail}）。未改綁。`,
      };
    }
    tx.trustedRoot = captured.trustedRoot;
    return {
      ok: true,
      value: { workDir: captured.binding.workDir, approvalKey: captured.approvalKey },
    };
  }

  /**
   * Phase 4 — move the local lease, persist the old incarnation, and reserve
   * the replacement record durably.
   *
   * The lease belongs with the reservation and not with the capture: it has to
   * be taken before the new session exists, and from the first line of this
   * phase every stop unwinds the same three things — the captured root, the
   * lease and the target checkout. Splitting them would duplicate that unwind
   * across a phase boundary.
   */
  private async reserveRebindTarget(
    tx: RebindTransaction,
    capture: RebindTargetCapture
  ): Promise<RebindStep<RebindReservation>> {
    const { old, session, target, threadId } = tx;
    const { inventory, world } = this.ports;
    // Take the lease BEFORE the new session exists, so a concurrent
    // `/repo dev local` in another thread cannot slip in between check and create.
    // Release the OLD one first: a local→local move to a DIFFERENT repo would
    // otherwise leave this thread holding the repo it just left, blocking every
    // other thread from it for ever.
    if (target.devMode === "local") {
      if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
      inventory.releaseLocalLease(threadId);
      const lease = inventory.acquireLocalLease(target.repoPath, threadId);
      if (!lease.ok) {
        await tx.trustedRoot?.close().catch(() => {});
        tx.trustedRoot = undefined;
        if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
        tx.restoreOldFileDelivery();
        this.restoreLeaseFor(threadId, old);
        await this.undoRebindWorktree(tx);
        return {
          ok: false,
          message: `🔒 \`${path.basename(target.repoPath)}\` 剛剛被 <#${lease.holder}> 取走 local 佔用，未改綁。`,
        };
      }
      tx.targetLeaseHeld = true;
      if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
    }

    if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
    const sessionId = randomUUID();
    const generation = this.store.nextGeneration();
    const previous = this.store.get(threadId);
    if (!previous) {
      // A live actor without its persist-first record is already an unsafe
      // state. Do not overwrite the only possible durable pointer with a
      // replacement whose rollback could not describe the old root.
      await tx.trustedRoot?.close().catch(() => {});
      tx.trustedRoot = undefined;
      tx.restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await this.undoRebindWorktree(tx);
      return {
        ok: false,
        message: "⚠️ 找不到目前 session 的耐久記錄，為避免遺失舊 runtime／worktree 擁有權，未改綁。",
      };
    }
    // A rebind replaces the SDK conversation but not the Discord thread that
    // owns this outbound capability, so retain its conservative quota.
    const fileDeliveryBytes = previous.fileDeliveryBytes;
    if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
    // Persist the old incarnation BEFORE `reserve()` replaces the mutable
    // thread slot. If `/end` wins during target create, this is the durable
    // pointer it terminalizes; it is never a resumable second session.
    tx.oldStale = this.staleRebindActor(old.actor, previous, true);
    if (!this.store.retainStaleRebind(previous, "rebind-cleanup-pending")) {
      await tx.trustedRoot?.close().catch(() => {});
      tx.trustedRoot = undefined;
      tx.restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await this.undoRebindWorktree(tx);
      return {
        ok: false,
        message: "⚠️ 無法持久化舊 session 的改綁清理記錄，未改綁。請檢查磁碟／權限後重試。",
      };
    }
    this.pendingRebindOlds.set(session, tx.oldStale);
    const reserved = this.store.reserve({
      threadId,
      sessionId,
      generation,
      repoPath: target.repoPath,
      guildId: world.guildId(),
      // The thread does not MOVE when its repo is rebound, so its parent is
      // whatever it already was. Writing the configured seed channel here (as
      // this did) silently relocated every rebound session onto the seed: a
      // session started in any other enabled channel then failed `bindingOk` on
      // the next restart and was marked `blocked` — terminal.
      parentChannelId: session.parentChannelId,
      workDir: capture.workDir,
      devMode: target.devMode,
      fileDeliveryBytes,
      branch: tx.branch,
    });
    if (!reserved) {
      await tx.trustedRoot?.close().catch(() => {});
      tx.trustedRoot = undefined;
      if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
      this.pendingRebindOlds.delete(session);
      this.store.removeStaleRebind(previous.threadId, previous.sessionId, previous.generation);
      tx.restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await this.undoRebindWorktree(tx);
      return {
        ok: false,
        message: "⚠️ 無法持久化 session 狀態（寫入磁碟失敗），未改綁。請檢查磁碟／權限後重試。",
      };
    }
    tx.reservedIdentity = { sessionId, generation };
    tx.restorablePrevious = previous;
    tx.replacementBinding = this.store.get(threadId);
    return { ok: true, value: { sessionId, generation, previous, fileDeliveryBytes } };
  }

  /** Phase 5 — create the replacement SDK session against the reservation.
   *
   *  The OLD session is still live and registered throughout, so a failure here
   *  restores only the row this attempt reserved and leaves the conversation
   *  exactly where it was. */
  private async createRebindReplacement(
    tx: RebindTransaction,
    capture: RebindTargetCapture,
    reservation: RebindReservation
  ): Promise<RebindStep<RebindReplacement>> {
    const { old, session, threadId } = tx;
    const { fileDeliveryBytes, generation, previous, sessionId } = reservation;
    const broker = new PendingInteractionBroker();
    let actor: SessionActor;
    try {
      if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
      actor = await this.ports.world.createReplacementActor({
        threadId,
        workDir: capture.workDir,
        approvalKey: capture.approvalKey,
        broker,
        ...(tx.trustedRoot ? { trustedRoot: tx.trustedRoot } : {}),
        sessionId,
        generation,
        fileDeliveryBytes,
      });
      tx.replacementActor = actor;
      tx.trustedRoot = undefined; // ownership transferred to the returned actor
    } catch (err) {
      // `SessionActor.create` owns and closes the captured root on every throw.
      tx.trustedRoot = undefined;
      if (!tx.ownsOldSession()) return { ok: false, message: await this.abandonRebind(tx) };
      // The OLD session is still live and registered — nothing has been swapped
      // yet — restore only the row this attempt reserved. Preserving a larger
      // total keeps a late replacement reservation monotonic, at the cost of
      // leaving old file delivery fenced when its in-memory total is stale.
      const rollback = this.store.restoreIfCurrent(previous, sessionId, generation);
      if (rollback.ok) {
        this.pendingRebindOlds.delete(session);
        this.store.removeStaleRebind(previous.threadId, previous.sessionId, previous.generation);
      }
      if (rollback.ok && !rollback.quotaAdvanced) tx.restoreOldFileDelivery();
      this.restoreLeaseFor(threadId, old);
      await this.undoRebindWorktree(tx);
      return {
        ok: false,
        message:
          `⚠️ 建立新的 Copilot session 失敗（${err instanceof Error ? err.message : String(err)}）。未改綁，原本的對話仍在。` +
          (rollback.ok && !rollback.quotaAdvanced
            ? ""
            : "\n⚠️ 為避免覆寫較新的檔案配額，原 session 的檔案傳送保持停用。"),
      };
    }
    return { ok: true, value: { actor, broker } };
  }

  /**
   * Phase 6 — commit the reservation and swap the in-memory session.
   *
   * Commit and swap are ONE phase because there is no await between them: an
   * ownership check separates them in the source, and inserting a suspension
   * point there would create a window in which `/end` could take the thread
   * after the record went `active` but before anything owned the replacement.
   *
   * For the same reason the retirement of the old incarnation is entered
   * SYNCHRONOUSLY at the end of this method rather than awaited by the caller:
   * between the map swap and `retainStaleRebindActor()` the detached
   * predecessor is owned by nothing, and `/end` reads the map to decide what it
   * owns.
   */
  private async commitRebindTransaction(
    tx: RebindTransaction,
    capture: RebindTargetCapture,
    reservation: RebindReservation,
    replacement: RebindReplacement
  ): Promise<string> {
    const { session, target, threadId } = tx;
    const { inventory, world } = this.ports;
    if (!tx.ownsOldSession()) return this.abandonRebind(tx);
    if (!this.store.commit(threadId)) {
      return this.rollbackFailedRebindCommit(tx, reservation, replacement);
    }

    // Swap. From here the new session owns the thread.
    if (!tx.ownsOldSession()) return this.abandonRebind(tx);
    const next: Session = {
      actor: replacement.actor,
      broker: replacement.broker,
      running: false,
      titled: session.titled,
      titleEpoch: session.titleEpoch,
      queue: [],
      workDir: capture.workDir,
      repoPath: target.repoPath,
      devMode: target.devMode,
      branch: tx.branch,
      parentChannelId: session.parentChannelId,
      hasRunTurn: false,
    };
    inventory.installSession(threadId, next);
    tx.replacementActor = undefined; // now owned by the live-session map
    tx.targetLeaseHeld = false; // now owned by the replacement, not this rollback
    if (target.devMode !== "local") inventory.releaseLocalLease(threadId);
    // Session-scoped approvals are grants for THIS conversation in THIS repo;
    // carrying them into a different repo would widen a grant the operator never
    // made there.
    world.clearSessionApprovals(threadId);
    return this.retireRebindPredecessor(tx, capture, next);
  }

  /** The commit failed, so this replacement never enters the live-session map.
   *  Retain it until a confirmed retry releases its root, and only then remove
   *  its target worktree: otherwise a live SDK process could become invisible
   *  while its working directory is deleted underneath it. */
  private async rollbackFailedRebindCommit(
    tx: RebindTransaction,
    reservation: RebindReservation,
    replacement: RebindReplacement
  ): Promise<string> {
    const { old, session, threadId } = tx;
    const { generation, previous, sessionId } = reservation;
    let replacementClosed = true;
    let replacementDurablyRetained = true;
    try {
      await withTimeout(replacement.actor.disconnect(), this.ports.world.runtimeTeardownTimeoutMs);
    } catch {
      replacementClosed = false;
      // A failed commit means this actor never enters the live-session map;
      // retain it until a confirmed retry releases its root, and only then
      // remove its target worktree. Otherwise a live SDK process could become
      // invisible while its working directory is deleted underneath it.
      if (tx.replacementBinding) {
        const fallback = this.fallbackPrimaryPlan(
          tx.replacementBinding,
          previous,
          tx.ownsOldSession,
          () => {
            if (tx.oldStale && this.pendingRebindOlds.get(session) === tx.oldStale) {
              this.pendingRebindOlds.delete(session);
            }
          },
          tx.restoreOldFileDelivery
        );
        // `/end` can claim the old actor while the initial teardown await is
        // pending. Install the removal plan BEFORE retain schedules a retry,
        // so that retry never sees a stale restore callback.
        if (!tx.ownsOldSession()) this.setFallbackPrimaryRemoval(fallback);
        replacementDurablyRetained = this.retainStaleRebindActor(
          this.staleRebindActor(replacement.actor, tx.replacementBinding, true),
          "rebind-teardown-unconfirmed",
          // The old actor is still current here. If this terminal row cannot
          // persist, a later confirmed retry may restore only this snapshot
          // under the target reservation's exact CAS.
          fallback,
          tx.scope
        );
      } else {
        console.warn("rebind: commit-failed replacement lost its durable binding before teardown");
        replacementDurablyRetained = false;
      }
    }
    if (!tx.ownsOldSession()) return this.abandonRebind(tx);
    // A failed terminal-row write leaves the target reservation as the only
    // durable pointer to the replacement. Restoring `previous` would erase
    // it, so hold that primary barrier until a confirmed retry can clean it.
    const holdTargetReservation = !replacementClosed && !replacementDurablyRetained;
    let rollback = { ok: false, quotaAdvanced: false };
    if (!holdTargetReservation) {
      rollback = this.store.restoreIfCurrent(previous, sessionId, generation);
      if (rollback.ok) {
        this.pendingRebindOlds.delete(session);
        this.store.removeStaleRebind(previous.threadId, previous.sessionId, previous.generation);
      }
    } else {
      console.warn(
        `rebind: retaining target reservation ${sessionId} as fallback after stale ownership write failure`
      );
    }
    if (rollback.ok && !rollback.quotaAdvanced) tx.restoreOldFileDelivery();
    this.restoreLeaseFor(threadId, old);
    if (replacementClosed) await this.undoRebindWorktree(tx);
    return (
      "⚠️ 無法持久化 session 狀態（commit 失敗），未改綁。請檢查磁碟／權限後重試。" +
      (rollback.ok && !rollback.quotaAdvanced
        ? ""
        : "\n⚠️ 為避免覆寫較新的檔案配額，原 session 的檔案傳送保持停用。") +
      (replacementClosed
        ? ""
        : holdTargetReservation
          ? "\n⚠️ 無法持久化新 runtime 的終止記錄；目標 session 記錄已保留為安全屏障，未完成清理。請重啟 bot 或稍後重試。"
          : "\n⚠️ 無法確認新 runtime 已停止；目標 worktree 暫時保留，會在確認停止後再清理。")
    );
  }

  /** Phase 7 — retire the old incarnation and answer the operator.
   *
   *  Entered with no await after the map swap: the old actor is no longer the
   *  thread's live session, so ownership must transfer to the stale tracker
   *  BEFORE its first disconnect await. `/end` can then join this exact
   *  operation rather than delete the replacement and leave the old
   *  root/worktree unowned. */
  private async retireRebindPredecessor(
    tx: RebindTransaction,
    capture: RebindTargetCapture,
    replacement: Session
  ): Promise<string> {
    const { branch, old, session, target, threadId } = tx;
    const { inventory } = this.ports;
    const ownsReplacement = (): boolean =>
      inventory.session(threadId) === replacement && !inventory.isEnded(replacement);

    // The old actor is no longer the thread's live session, so ownership
    // transfers to the stale tracker BEFORE its first disconnect await. `/end`
    // can now join this exact operation rather than delete the replacement and
    // leave the old root/worktree unowned.
    const detachedOld = tx.oldStale;
    if (!detachedOld) {
      // This can only happen after a broken in-memory mutation; fail closed by
      // leaving the replacement active rather than pretending its predecessor
      // was retired.
      return "⚠️ 舊 session 的改綁清理擁有權遺失，為安全起見未完成改綁。請重啟 bot。";
    }
    this.pendingRebindOlds.delete(session);
    // Registered as an OWNED obligation, exactly as every other detached
    // incarnation is. The successful-rebind path is the commonest way one of
    // these is created, and it was the one route that only added this
    // coordinator's index entry: a `disconnect` nobody could confirm here left a
    // runtime holding the old worktree while the process lock was free to be
    // released. The obligation is entered BEFORE the teardown attempt below, so
    // a concurrent `stop()` sees it, and `disconnectStaleRebindActor` discharges
    // it by identity once the runtime is confirmed.
    this.retainStaleRebindActor(detachedOld, "rebind-cleanup-pending", undefined, tx.scope);
    const oldTeardown = await this.disconnectStaleRebindActor(detachedOld);
    if (!oldTeardown.confirmed) this.scheduleStaleRebindRetry(detachedOld);
    // Cleanup happened (or its durable unconfirmed record was installed)
    // BEFORE this fence. Thus a winning `/end` cannot skip old cleanup merely
    // because it removed the replacement from the map while we were awaiting.
    if (!ownsReplacement()) return REBIND_ENDED;
    let tail = oldTeardown.tail;
    if (
      !oldTeardown.confirmed &&
      old.devMode === "worktree" &&
      old.branch &&
      old.workDir !== old.repoPath
    ) {
      tail += `\n🌿 舊的 worktree **保留**：\`${old.workDir}\`（分支 \`${old.branch}\`）—— 無法確認舊 runtime 已停止，不在此時移除。`;
    }
    return (
      `✅ 已改綁到 \`${path.basename(target.repoPath)}\` · \`${target.devMode}\`` +
      (branch ? `（分支 \`${branch}\`）` : "（直接在 repo 本體上開發）") +
      `\n📂 工作目錄：\`${capture.workDir}\`\n🧠 這是一段全新的對話，先前的歷史不再沿用。` +
      (target.devMode === "local"
        ? "\n⚠️ local 模式：agent 會直接改這個 repo 的工作區，`/end` 沒有東西可以清除。"
        : "") +
      tail
    );
  }

  /**
   * Dispose resources prepared after this transaction lost the old session.
   *
   * The one rollback shared by every phase, which is why the transaction
   * carries its obligations rather than each phase owning them: this method
   * disposes exactly what has been created so far, whichever phase noticed.
   *
   * TWO different losers reach here, and they want opposite things.
   *
   * `/end` is the winner and deliberately gave the old conversation up: its
   * target reservation is REMOVED and the old primary stays gone.
   *
   * A shutdown gave up nothing. The old record was moved aside (a stale
   * companion row) and its thread slot overwritten with the target
   * reservation, so removing the target alone leaves the thread with NO
   * resumable primary — the conversation survives only as a terminal
   * stale-rebind pointer, and the next boot cannot bring it back. The
   * pre-swap rollbacks above already restore `previous` under the exact CAS;
   * this does the same, so a signal in the middle of a rebind costs the
   * operator the rebind and nothing else.
   */
  private async abandonRebind(tx: RebindTransaction): Promise<string> {
    const { session, threadId } = tx;
    // The first commit-failure disconnect may have raced `/end` before its
    // fallback tracker was registered. Flip an existing plan synchronously;
    // a plan created below is removal-only as well.
    //
    // Only for `/end`. A shutdown must NOT turn a restore into a removal: the
    // owner never gave up the old record, and the next boot is expected to
    // resume it. Overwriting `/end`'s outcome, or a shutdown's, with the
    // other's is exactly what this distinction prevents.
    if (tx.endedByCommand()) this.markFallbackPrimaryEnded(threadId);
    // Decided ONCE, before any await: `endedByCommand()` reads the live map,
    // which shutdown's teardown clears, so asking again later would silently
    // turn "the process is stopping" into "the operator ended it".
    const givenUpByOperator = tx.endedByCommand();
    const trackedReplacement =
      tx.replacementActor === undefined ? undefined : this.staleRebindActors.get(tx.replacementActor);
    if (trackedReplacement?.fallbackPrimary) {
      // The fallback owns BOTH the primary reservation and the terminal
      // tracker. Its cleanup must run through one CAS transaction: removing
      // the primary here would strand the tracker if its later reconciliation
      // loses the target or cannot persist.
      const teardown = await this.disconnectStaleRebindActor(trackedReplacement);
      this.releaseRebindTargetLease(tx);
      return `${REBIND_ENDED}${teardown.tail}`;
    }

    let replacementClosed = true;
    let replacementDurablyRetained = true;
    let fallbackPrimaryRetained = false;
    if (tx.replacementActor) {
      try {
        await withTimeout(tx.replacementActor.disconnect(), this.ports.world.runtimeTeardownTimeoutMs);
      } catch {
        replacementClosed = false;
        // Retain the actor and root fence until a retry can CONFIRM teardown;
        // do not let a timed-out `/end` turn it into an invisible writer.
        if (tx.replacementBinding) {
          const fallback = this.fallbackPrimaryPlan(
            tx.replacementBinding,
            // A shutdown keeps the RESTORE plan: when a later retry finally
            // confirms this replacement stopped, the old primary comes back
            // under the target's exact CAS. `/end` gets the removal-only
            // plan, because it gave the old conversation up on purpose.
            givenUpByOperator ? undefined : tx.restorablePrevious,
            givenUpByOperator ? undefined : tx.ownsOldSession,
            givenUpByOperator
              ? undefined
              : () => {
                  if (tx.oldStale && this.pendingRebindOlds.get(session) === tx.oldStale) {
                    this.pendingRebindOlds.delete(session);
                  }
                },
            givenUpByOperator ? undefined : tx.restoreOldFileDelivery
          );
          if (givenUpByOperator) this.setFallbackPrimaryRemoval(fallback);
          const stale = this.staleRebindActor(tx.replacementActor, tx.replacementBinding, true);
          replacementDurablyRetained = this.retainStaleRebindActor(
            stale,
            "rebind-teardown-unconfirmed",
            // `/end` already claimed the old session. If persistence fails,
            // retry may remove only this exact target reservation.
            fallback,
            tx.scope
          );
          fallbackPrimaryRetained = stale.fallbackPrimary !== undefined;
        } else {
          // This should be unreachable: a replacement actor is created only
          // after reserve has produced its immutable binding. Do not close a
          // root we cannot durably describe.
          console.warn("rebind: replacement actor lost its durable binding before teardown");
          replacementDurablyRetained = false;
        }
      }
    } else {
      await tx.trustedRoot?.close().catch(() => {});
    }
    // If the terminal stale row could not be written, the target reservation
    // is the only crash-surviving pointer to this possibly-live replacement.
    // Never remove it until teardown is durably represented elsewhere.
    if (!fallbackPrimaryRetained) {
      if (tx.reservedIdentity && (replacementClosed || replacementDurablyRetained)) {
        if (givenUpByOperator || !tx.restorablePrevious) {
          this.store.removeIfCurrent(
            threadId,
            tx.reservedIdentity.sessionId,
            tx.reservedIdentity.generation
          );
        } else {
          // Shutdown: put the old primary BACK. Removing the target alone
          // left the thread with no resumable record at all, so the next boot
          // saw only a terminal stale pointer and the conversation was lost —
          // for a rebind the operator never even completed. The same CAS the
          // create-failure path uses, so a newer reservation cannot be
          // clobbered.
          const restored = tx.restorablePrevious;
          const rollback = this.store.restoreIfCurrent(
            restored,
            tx.reservedIdentity.sessionId,
            tx.reservedIdentity.generation
          );
          if (rollback.ok) {
            this.pendingRebindOlds.delete(session);
            this.store.removeStaleRebind(restored.threadId, restored.sessionId, restored.generation);
          } else {
            console.warn(
              `rebind: could not restore the primary record for ${threadId} after a shutdown; ` +
                "leaving the target reservation and the stale companion for reconcile."
            );
          }
        }
      } else if (tx.reservedIdentity) {
        console.warn(
          `rebind: retaining target reservation ${tx.reservedIdentity.sessionId} as fallback after stale ownership write failure`
        );
      }
    }
    this.releaseRebindTargetLease(tx);
    if (replacementClosed) await this.undoRebindWorktree(tx);
    if (!replacementClosed && !replacementDurablyRetained) {
      return (
        `${REBIND_ENDED}\n` +
        "⚠️ 無法持久化新 runtime 的終止記錄；目標 session 記錄已保留為安全屏障，未完成清理。請重啟 bot 或稍後重試。"
      );
    }
    return REBIND_ENDED;
  }
}

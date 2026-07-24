import type { SessionState } from "./session-store.js";

/**
 * Classification of the Discord thread a persisted session is bound to, as seen
 * at startup. `transient` MUST be distinguished from definitive absence so a
 * network blip / 429 / 5xx at startup can't be misread as "thread gone" and drop
 * a recoverable session.
 */
export type ThreadStatus =
  | "valid" // exists, in the right guild/parent, sendable (unarchived if needed)
  | "gone" // definitive 404 (Unknown Channel)
  | "inaccessible" // 403 / missing access / wrong guild-parent / not a thread / locked
  | "archived-unarchivable" // archived and we couldn't unarchive or it's still unsendable
  | "transient"; // network / 429 / 5xx / unknown — retryable, do NOT reclassify as gone

export type ReconcileAction =
  | { kind: "fresh" } // no record — nothing to do
  | { kind: "fail-corrupt" } // store file present but unreadable — fail startup
  | { kind: "orphan-interrupted" } // a `creating` record — creation didn't complete
  | { kind: "retain" } // already orphaned/blocked — leave as-is (no auto-clear)
  | { kind: "resume" } // active + binding ok + thread valid — resume it
  | { kind: "block"; reason: string } // active but not resumable now — persist blocked
  | { kind: "skip"; reason: string }; // transient failure — leave record unchanged, don't resume

/**
 * Pure reconciliation planner: given the durable record's state, whether the
 * stored binding still matches this bot's config/repo, and the thread status,
 * decide what to do on startup. All Discord/SDK I/O happens in the caller; this
 * function is the decision matrix (unit-tested exhaustively).
 */
export function planReconcile(input: {
  corrupt: boolean;
  state?: SessionState;
  bindingOk?: boolean; // computed by the caller for `active` records
  threadStatus?: ThreadStatus; // fetched by the caller only for active + bindingOk
}): ReconcileAction {
  if (input.corrupt) return { kind: "fail-corrupt" };
  if (!input.state) return { kind: "fresh" };

  switch (input.state) {
    case "creating":
      // A reserve that never reached commit (crash during create). Do NOT resume a
      // half-activated session; mark orphaned so the user starts fresh.
      return { kind: "orphan-interrupted" };
    case "orphaned":
    case "blocked":
      // Terminal-until-/new: never auto-clear (that would make these states
      // useless and could hide a real problem).
      return { kind: "retain" };
    case "active":
      if (input.bindingOk === false) {
        // e.g. CONTROLLED_REPO_PATH or guild/parent changed between runs — resuming
        // would run repo A's conversation while tools execute in repo B.
        return { kind: "block", reason: "config-mismatch" };
      }
      switch (input.threadStatus) {
        case "valid":
          return { kind: "resume" };
        case "gone":
          return { kind: "block", reason: "thread-gone" };
        case "inaccessible":
          return { kind: "block", reason: "thread-inaccessible" };
        case "archived-unarchivable":
          return { kind: "block", reason: "thread-archived" };
        case "transient":
          return { kind: "skip", reason: "transient-thread-fetch" };
        default:
          // No thread status supplied for an active record → caller error; be safe.
          return { kind: "skip", reason: "unknown-thread-status" };
      }
    default:
      return { kind: "skip", reason: "unknown-state" };
  }
}

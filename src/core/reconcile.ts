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
 * Classify a `resumeSession` error. Deliberately CONSERVATIVE: only a definitive
 * "this session id no longer exists" signal is treated as terminal (`session-lost`
 * → orphaned). Everything else — network/DNS/timeout/RPC/unknown — is `transient`
 * so the record is LEFT ACTIVE and a later restart retries, never dropping the
 * conversation history P2 exists to preserve. (Network strings like "no such host
 * is known" / ENOTFOUND must NOT be mistaken for a missing session.)
 */
export function classifyResumeError(message: string): "session-lost" | "transient" {
  const m = message.toLowerCase();
  const networkish =
    /enotfound|econnrefused|econnreset|etimedout|econnaborted|timed? ?out|socket|network|no such host|getaddrinfo|fetch failed|dns|502|503|504|unavailable|refused/.test(
      m
    );
  if (networkish) return "transient";
  // Precise "the session itself is gone" phrases only.
  if (/session (?:not found|does not exist|no longer exists|is gone|unknown|expired)/.test(m)) return "session-lost";
  if (/unknown session|no such session|session id .*(?:not found|invalid|unknown)/.test(m)) return "session-lost";
  return "transient"; // default: retryable — never lose history on an ambiguous error
}

/**
 * What may be done with a durable record that has no live session right now.
 *
 * "Not in the live map" is NOT the same as "dead leftover", and conflating them
 * destroys data in two distinct ways:
 *
 * - `in-flight` — `/new` persists its record BEFORE the multi-second
 *   `SessionActor.create()` and only registers the live session afterwards.
 *   Reaping inside that window pulls the worktree and record out from under it.
 * - `retry-pending` — reconcile deliberately KEEPS an `active` record when a
 *   resume fails transiently, so the next restart retries. Deleting it discards
 *   the only pointer to a Copilot conversation that would have come back.
 *
 * Only the terminal states (`orphaned`, `blocked`) are leftovers, and even then
 * the worktree is removed only if git says it is safe.
 */
export type RecordDisposition = "live" | "in-flight" | "retry-pending" | "reapable";

export function classifyRecordDisposition(
  state: SessionState,
  isLive: boolean,
  newInFlight: boolean
): RecordDisposition {
  if (isLive) return "live";
  // `newInFlight` is a single global flag, so it may belong to a DIFFERENT
  // thread's /new. Erring towards "in-flight" only ever refuses a cleanup — the
  // safe direction.
  if (state === "creating") return newInFlight ? "in-flight" : "reapable";
  if (state === "active") return "retry-pending";
  return "reapable";
}

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

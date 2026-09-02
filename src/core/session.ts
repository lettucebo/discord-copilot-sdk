import type { SessionActor } from "../copilot/session-actor.js";
import type { PendingInteractionBroker } from "./broker.js";
import type { DevMode } from "./binding.js";

/** One live Discord thread ↔ Copilot session. Exported so tests can build a
 *  TYPED fixture — an untyped `as Record<string, unknown>` fixture is how a
 *  missing field reaches runtime instead of the typechecker.
 *
 *  It lives HERE rather than in `app.ts` because the rebind coordinator both
 *  reads and installs one: a coordinator that had to import the app for this
 *  shape would be coupled to the whole orchestrator to describe its own input. */
export interface Session {
  actor: SessionActor;
  broker: PendingInteractionBroker;
  running: boolean;
  /** Set while a turn is reserved but the prompt hasn't been handed to the agent
   *  yet (e.g. during image download). /stop aborts this to cancel before send. */
  currentAbort?: AbortController;
  /** True once the thread carries a real title (from /new's prompt option, a
   *  first message, an explicit /rename, or because it is a RESUMED thread that
   *  was already named). Gates the one automatic rename per session. */
  titled: boolean;
  /** Bumped by every explicit /rename. A titler that was already in flight
   *  compares this before writing, so it can never clobber a name the operator
   *  just chose. */
  titleEpoch: number;
  /** Prompts waiting to run after the current turn, added with `/queue`. Held
   *  HERE and not in the runtime's own queue on purpose: `session.abort()` does
   *  NOT drain the runtime queue (verified — a queued message still ran after an
   *  abort), so `/stop` could not honestly stop anything we had pushed there. */
  queue: string[];
  /** Directory this session's agent works in — its own git worktree, or the repo
   *  itself under `local` dev mode. */
  workDir: string;
  /** The repo this session is bound to (canonical, under `REPOS_ROOT`). */
  repoPath: string;
  /** How this session gets its working directory. */
  devMode: DevMode;
  /** Branch checked out in `workDir` when it is a worktree we created. */
  branch?: string;
  /** The channel this session's thread hangs under. Carried HERE rather than
   *  re-derived per call site: with several enabled channels, "the parent" is no
   *  longer a constant, and a site that reached for the config value instead is
   *  exactly the bug that broke rebind (it rewrote every record's parent to the
   *  seed channel, so any session started elsewhere failed to resume). */
  parentChannelId: string;
  /** True once a turn has actually run, i.e. the session carries conversation
   *  history worth warning about before a rebind throws it away. A resumed
   *  session is initialised `true`: preserving history is the entire point of
   *  resume, so by definition it has some. Deliberately NOT derived from
   *  `titled` — `/rename` and resume both set that. */
  hasRunTurn: boolean;
}

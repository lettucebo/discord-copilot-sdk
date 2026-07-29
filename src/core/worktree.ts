import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

/** How a session's working directory is obtained. */
export type Isolation = "worktree" | "shared" | "impossible";

/**
 * Decide how to isolate concurrent sessions.
 *
 * Concurrent sessions in ONE directory is not a mode this can safely offer by
 * default: two agents editing the same checkout silently overwrite each other,
 * and a `git checkout` in one destroys the other's uncommitted work. A git
 * worktree gives each session its own files while sharing the object store, so
 * it is the default wherever git can provide it.
 *
 * `shared` remains reachable — a non-git controlled directory leaves no choice,
 * and read-only exploration across several threads is legitimate. What is NOT
 * offered is silently downgrading a request for isolation: asking for
 * `worktree` where it is impossible returns `impossible` so the caller can say
 * so instead of quietly running unprotected.
 */
export function chooseIsolation(o: {
  isGitRepo: boolean;
  configured?: "worktree" | "shared";
}): Isolation {
  if (o.configured === "shared") return "shared";
  if (!o.isGitRepo) return o.configured === "worktree" ? "impossible" : "shared";
  return "worktree";
}

/** Branch name for a session's worktree. Namespaced under `copilot/` so it is
 *  obvious where these came from, and sanitised so a thread id can never inject
 *  git ref syntax (`~ ^ : ? * [ \` space, `..`, leading/trailing dots). */
export function worktreeBranch(threadId: string): string {
  const safe = threadId
    .replace(/[^A-Za-z0-9._-]+/g, "-") // anything not clearly safe becomes a dash
    .replace(/\.{2,}/g, "-") // `..` is illegal in a ref
    .replace(/^[-.]+|[-.]+$/g, "") // no leading/trailing dot or dash
    .replace(/-{2,}/g, "-");
  return `copilot/t-${safe || "session"}`;
}

/** Directory for a session's worktree. The thread id is sanitised and the
 *  result is asserted to stay under `root`, so a hostile id cannot traverse. */
export function worktreePath(root: string, threadId: string): string {
  const leaf = threadId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, "-") || "session";
  const p = path.join(root, leaf);
  const rel = path.relative(root, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return path.join(root, "session");
  return p;
}

/** Whether `dir` is inside a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** The repository root for `dir` — the identity that "always allow for this
 *  repo" rules are keyed by, so a rule granted in one worktree applies in the
 *  others rather than silently re-prompting per session. */
export async function repoRoot(dir: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
    // .../<root>/.git  →  <root>
    const common = stdout.trim();
    return common ? path.resolve(path.dirname(common)) : path.resolve(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Create the worktree for a session. Idempotent: an existing worktree at that
 * path (e.g. left by a crash, or being resumed) is reused rather than failing,
 * because destroying it could throw away uncommitted work.
 */
export async function addWorktree(repo: string, dir: string, branch: string): Promise<void> {
  const { existsSync } = await import("node:fs");
  if (existsSync(dir)) return; // reuse — never clobber a directory that exists
  try {
    await run("git", ["worktree", "add", "-b", branch, dir], { cwd: repo });
  } catch (err) {
    // The branch may already exist (a previous session with the same thread id).
    // Attach to it rather than failing the whole /new.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(msg)) throw err;
    await run("git", ["worktree", "add", dir, branch], { cwd: repo });
  }
}

/**
 * Remove a session's worktree — but ONLY when it is provably safe.
 *
 * Two independent gates, because "git status is clean" answers a narrower
 * question than people assume:
 *
 * 1. **No local content.** Modified, untracked OR ignored — any of them keeps
 *    the tree. Uncommitted work is the operator's, not ours to discard.
 * 2. **HEAD is still the branch we recorded.** A clean tree on a *detached*
 *    HEAD can carry commits that nothing else points at; the worktree's own
 *    HEAD is the only ref holding them, and `git worktree remove` deletes it,
 *    making that work unreachable and GC-eligible. "The branch survives" is no
 *    protection there — the branch never moved. Same for a HEAD switched to a
 *    different branch than the record's: what we promise to keep is not what is
 *    actually checked out, so we refuse and let a human look.
 */
export async function removeWorktreeIfClean(
  repo: string,
  dir: string,
  expectBranch?: string
): Promise<"removed" | "kept-dirty" | "kept-detached" | "failed"> {
  try {
    // `--ignored=matching` matters: plain `git status --porcelain` hides
    // .gitignore'd paths, so a worktree whose only local content is ignored
    // (a .env, generated data, build output) would read as clean and
    // `git worktree remove` would delete it recursively.
    const { stdout } = await run("git", ["status", "--porcelain", "--ignored=matching"], { cwd: dir });
    if (stdout.trim().length > 0) return "kept-dirty";
  } catch {
    return "failed"; // can't prove it's clean → keep it
  }
  if (expectBranch) {
    try {
      // `symbolic-ref` fails outright on a detached HEAD — exactly the case we
      // must not delete. Also covers an in-progress rebase, which detaches.
      const { stdout } = await run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: dir });
      if (stdout.trim() !== `refs/heads/${expectBranch}`) return "kept-detached";
    } catch {
      return "kept-detached";
    }
  }
  try {
    await run("git", ["worktree", "remove", dir], { cwd: repo });
    return "removed";
  } catch {
    return "failed";
  }
}

/** Drop worktree bookkeeping for directories that no longer exist. Safe to run
 *  at startup; never touches a worktree whose directory is present. */
export async function pruneWorktrees(repo: string): Promise<void> {
  try {
    await run("git", ["worktree", "prune"], { cwd: repo });
  } catch {
    /* bookkeeping only — never fail startup for this */
  }
}

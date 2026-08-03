import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathRelation } from "./repo.js";

const run = promisify(execFile);

/**
 * Environment for every git probe whose ANSWER we rely on.
 *
 * `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` override repository discovery
 * entirely: with them set, `git -C <anywhere> rev-parse --git-common-dir` reports
 * the repository they name, not the one at `<anywhere>`. The bot inherits the
 * environment of whatever started it — a shell inside another repo, a wrapper
 * script, a CI runner — so a binding "proof" that inherits them is not a proof
 * at all. Blanked here rather than in the caller so no probe can forget.
 */
const GIT_PROBE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
};

/** Branch name for a session's worktree. Namespaced under `copilot/` so it is
 *  obvious where these came from, and sanitised so a thread id can never inject
 *  git ref syntax (`~ ^ : ? * [ \` space, `..`, leading/trailing dots).
 *
 *  Two threads on DIFFERENT repos may share a branch name; that is harmless,
 *  because a branch only exists inside its own repository. */
export function worktreeBranch(threadId: string): string {
  const safe = threadId
    .replace(/[^A-Za-z0-9._-]+/g, "-") // anything not clearly safe becomes a dash
    .replace(/\.{2,}/g, "-") // `..` is illegal in a ref
    .replace(/^[-.]+|[-.]+$/g, "") // no leading/trailing dot or dash
    .replace(/-{2,}/g, "-");
  return `copilot/t-${safe || "session"}`;
}

/**
 * Stable directory-name segment for a repo: a readable basename plus a hash of
 * its canonical path.
 *
 * The basename alone would collide across two repos of the same name in
 * different roots; the hash alone would be unreadable in a directory listing and
 * in the "leftover worktrees" report, where the whole point is to tell a human
 * which project a stray checkout belongs to.
 *
 * Case-folded on Windows only, matching `pathRelation` — on Linux `/srv/Repos`
 * and `/srv/repos` are different directories and must hash differently.
 */
export function repoSlug(repoPath: string): string {
  const canonical = path.resolve(repoPath);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 10);
  const base = path.basename(canonical).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return `${base || "repo"}-${hash}`;
}

/**
 * Directory for a session's worktree: `<root>/<repoSlug>/<threadId>`.
 *
 * The repo segment is NOT cosmetic. With one controlled repo the layout was flat
 * (`<root>/<threadId>`) and that was fine, but with many repos it is a real bug:
 * `addWorktree` reuses an existing directory rather than clobbering it, so
 * rebinding a thread from repo A to repo B would find A's checkout still sitting
 * at `<root>/<threadId>`, keep it, and leave the session working in A while its
 * record said B.
 *
 * Both segments are sanitised and the result is asserted to stay under `root`,
 * so a hostile id cannot traverse.
 */
export function worktreePath(root: string, repoPath: string, threadId: string): string {
  const leaf = threadId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, "-") || "session";
  const p = path.join(root, repoSlug(repoPath), leaf);
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
 *  others rather than silently re-prompting per session.
 *
 *  LENIENT: falls back to `dir` when git cannot answer. That is right for
 *  DISPLAY, but note it is used as the approval key, where a wrong answer is not
 *  merely an extra prompt — two directories that resolve to the same key would
 *  share "always allow" rules. It is only ever called on a path that
 *  `validateBinding` has already proved, which is what keeps that safe; do not
 *  reach for it anywhere else. Use `repoRootStrict` for validation. */
export async function repoRoot(dir: string): Promise<string> {
  try {
    return await repoRootStrict(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * The owning repository of `dir`, or THROW.
 *
 * `--git-common-dir` (not `--git-dir`) is what makes this work for a linked
 * worktree: git points the common dir at the MAIN repo's `.git`, so a worktree
 * reports the repo it was created from rather than its own bookkeeping
 * directory. That is exactly the question `validateBinding` has to answer —
 * "does this working directory really belong to the repo the record claims?" —
 * and it must never be answerable by accident, hence no fallback.
 */
export async function repoRootStrict(dir: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: dir,
    env: GIT_PROBE_ENV,
  });
  // git prints forward slashes even on Windows; realpath normalises them AND
  // resolves junctions, so two names for one directory compare equal.
  const common = stdout.trim();
  if (!common) throw new Error(`git could not report a common dir for ${dir}`);
  const root = path.resolve(path.dirname(common));
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * The working-tree root git itself reports for `dir`, canonicalised, or THROW.
 *
 * `--git-common-dir`'s parent is NOT always the working tree: a submodule, a
 * `--separate-git-dir` clone and a linked worktree all put the git directory
 * somewhere else entirely. `--show-toplevel` answers the question directly, so
 * "is this directory its own repository root?" is decided by git rather than by
 * a guess about directory layout.
 */
export async function topLevelStrict(dir: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
    cwd: dir,
    env: GIT_PROBE_ENV,
  });
  const top = stdout.trim();
  if (!top) throw new Error(`git could not report a top level for ${dir}`);
  const resolved = path.resolve(top);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Create the worktree for a session. Idempotent: an existing worktree at that
 * path (e.g. left by a crash, or being resumed) is reused rather than failing,
 * because destroying it could throw away uncommitted work.
 *
 * Reuse is guarded, though. "The directory exists, so it must be ours" was safe
 * when one repo owned every worktree path; with many repos it is how a rebound
 * thread ends up working in the repo it was moved AWAY from. So a directory that
 * is already there must prove it belongs to `repo` before it is adopted —
 * anything else fails closed rather than silently binding the wrong tree.
 */
export async function addWorktree(repo: string, dir: string, branch: string): Promise<void> {
  if (fs.existsSync(dir)) {
    let owner: string;
    try {
      owner = await repoRootStrict(dir);
    } catch (err) {
      throw new Error(
        `${dir} already exists but git cannot say which repo it belongs to ` +
          `(${err instanceof Error ? err.message : String(err)}). Refusing to adopt it.`
      );
    }
    if (pathRelation(owner, repo) !== "same") {
      throw new Error(`${dir} already exists and belongs to ${owner}, not ${repo}. Refusing to adopt it.`);
    }
    return; // ours — reuse, never clobber
  }
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

/** What a worktree currently holds, WITHOUT touching it. */
export type WorktreeCondition = "clean" | "absent" | "dirty" | "detached" | "unknown";

/**
 * Read-only counterpart of `removeWorktreeIfClean`: answers "would it be safe to
 * let go of this tree?" without acting on the answer.
 *
 * It exists because `removeWorktreeIfClean` DELETES when the answer is "clean",
 * which makes it unusable as the pre-flight check for `/repo set` — asking
 * whether a rebind is allowed must not be the thing that destroys the tree if it
 * is. The two share their definition of "safe" (see that function for why both
 * gates are needed); only the consequence differs.
 */
export async function inspectWorktree(dir: string, expectBranch?: string): Promise<WorktreeCondition> {
  if (!fs.existsSync(dir)) return "absent";
  try {
    const { stdout } = await run("git", ["status", "--porcelain", "--ignored=matching"], { cwd: dir });
    if (stdout.trim().length > 0) return "dirty";
  } catch {
    return "unknown";
  }
  if (expectBranch) {
    try {
      const { stdout } = await run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: dir });
      if (stdout.trim() !== `refs/heads/${expectBranch}`) return "detached";
    } catch {
      return "detached";
    }
  }
  return "clean";
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
): Promise<"removed" | "already-absent" | "kept-dirty" | "kept-detached" | "failed"> {
  // "The directory is gone" is not a failure, and conflating the two strands
  // records for ever: a caller that keeps the record whenever cleanup != removed
  // can never let go of one whose tree is already absent, because every retry
  // fails identically. This happens by following our own advice — we tell the
  // operator to `git worktree remove` a tree we declined to touch — and after a
  // crash between removing the tree and removing the record.
  if (!fs.existsSync(dir)) {
    await pruneWorktrees(repo); // drop git's now-dangling bookkeeping too
    return "already-absent";
  }
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

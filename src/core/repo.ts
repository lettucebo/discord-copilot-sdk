import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

/**
 * Resolve and validate the single controlled repository path (v1 lab scope).
 *
 * Returns the *canonical* absolute path to be used everywhere — the SDK
 * session `workingDirectory` and any identity derived from it — so symlinks and
 * relative inputs cannot later diverge. Throws a clear error on any problem.
 *
 * NOTE: this is policy/hygiene, not a sandbox. In v1 (lab-only) the agent can
 * still escape a path via shell/symlink; real isolation is the controller/worker
 * split tracked separately.
 */
export function resolveControlledRepo(input: string): string {
  if (!input || !path.isAbsolute(input)) {
    throw new Error(
      `CONTROLLED_REPO_PATH must be an absolute path (got: ${input || "(empty)"})`
    );
  }
  if (!existsSync(input)) {
    throw new Error(`CONTROLLED_REPO_PATH does not exist: ${input}`);
  }
  const real = realpathSync(input);
  if (!statSync(real).isDirectory()) {
    throw new Error(`CONTROLLED_REPO_PATH is not a directory: ${real}`);
  }
  // A git working-tree root has a `.git` entry (dir for a normal clone, file for
  // a worktree). A subdirectory of a repo has none, so this also enforces "root".
  if (!existsSync(path.join(real, ".git"))) {
    throw new Error(
      `CONTROLLED_REPO_PATH is not a git working-tree root (no .git entry): ${real}`
    );
  }
  return real;
}

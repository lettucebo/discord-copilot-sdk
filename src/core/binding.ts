import path from "node:path";
import { canonicalPathOr, isGitWorkTreeRoot, isStrictlyInside, pathRelation } from "./repo.js";
import { repoRootStrict, topLevelStrict } from "./worktree.js";

/**
 * How a session's working directory relates to its repo.
 *
 * `local`    — the agent works directly in `REPOS_ROOT/<repo>`. At most ONE live
 *              session per repo (two agents in one checkout silently overwrite
 *              each other, and a `git checkout` in one destroys the other's
 *              uncommitted work).
 * `worktree` — the agent gets its own git worktree, so any number of sessions
 *              can share a repo safely. The default.
 */
export type DevMode = "local" | "worktree";

export function isDevMode(v: unknown): v is DevMode {
  return v === "local" || v === "worktree";
}

/** A binding to be proved: which repo, where the agent works, and how. */
export interface Binding {
  repoPath: string;
  workDir: string;
  devMode: DevMode;
  branch?: string | undefined;
}

export interface BindingDeps {
  reposRoot: string;
  worktreeRoot: string;
  /** MUST reject when git cannot answer — see `repoRootStrict`. Injectable so
   *  the pure rules can be tested without spawning git. */
  ownerOf?: (dir: string) => Promise<string>;
  /** The working-tree root git reports for a directory. MUST reject on failure. */
  topLevelOf?: (dir: string) => Promise<string>;
}

/** Why a binding was refused. Stable strings: they end up in a record's
 *  `reason` and in the startup announcement. */
export type BindingProblem =
  | "repo-outside-root"
  | "repo-not-git"
  | "local-workdir-mismatch"
  | "local-has-branch"
  | "worktree-outside-root"
  | "worktree-no-branch"
  | "worktree-owner-mismatch"
  | "worktree-owner-unknown";

export type BindingVerdict = { ok: true } | { ok: false; problem: BindingProblem; detail: string };

/**
 * Prove — not assume — that a working directory belongs to the repo it claims.
 *
 * The rule this replaces compared `rec.repoPath` against the ONE configured
 * repo and checked that `workDir` started with the worktree root. With many
 * repos that is no longer a proof of anything: every session's worktree lives
 * under the same root, so a record naming repo B while pointing at repo A's
 * worktree passes a prefix test and then runs one repo's conversation against
 * another repo's files. The only thing that actually answers the question is
 * git itself, via `--git-common-dir`, and it must answer for real: a git failure
 * is a refusal, never a pass.
 *
 * Called at every point a binding comes into existence or comes back —
 * `/new`, `/repo set|clone|new|dev`, and resuming a persisted record.
 *
 * It canonicalises with `realpath`, so a junction under the worktree root that
 * points at a main checkout cannot pose as a second identity, and it scrubs
 * `GIT_DIR`/`GIT_WORK_TREE` from the probe environment (see `GIT_PROBE_ENV`) —
 * a git that inherits those answers about a repository nobody asked about.
 *
 * What it does NOT check, deliberately: that a worktree's HEAD is still on its
 * recorded branch. A session interrupted mid-rebase legitimately has a detached
 * HEAD, and refusing to resume it would strand the conversation. The rebind path
 * DOES require it (`inspectWorktree`), because there the tree is about to be let
 * go of rather than picked up.
 */
export async function validateBinding(b: Binding, deps: BindingDeps): Promise<BindingVerdict> {
  const owner = deps.ownerOf ?? repoRootStrict;
  const topLevel = deps.topLevelOf ?? topLevelStrict;
  // Canonicalise BOTH sides. `path.resolve` alone leaves a junction as a second
  // name for one directory, and on Windows a short (8.3) name as a third — so a
  // link under the worktree root, or a tmpdir like `C:\Users\RUNNER~1\...`,
  // would compare unequal to the very directory it IS. See `canonicalPath`.
  const canon = canonicalPathOr;
  const repo = canon(b.repoPath);
  const work = canon(b.workDir);

  if (!isStrictlyInside(repo, canon(deps.reposRoot))) {
    return {
      ok: false,
      problem: "repo-outside-root",
      detail: `${repo} is not inside REPOS_ROOT (${deps.reposRoot})`,
    };
  }
  if (!isGitWorkTreeRoot(repo)) {
    return { ok: false, problem: "repo-not-git", detail: `${repo} has no .git entry` };
  }

  if (b.devMode === "local") {
    if (pathRelation(work, repo) !== "same") {
      return {
        ok: false,
        problem: "local-workdir-mismatch",
        detail: `local mode must work in the repo itself, but workDir is ${work} and repo is ${repo}`,
      };
    }
    // A `.git` ENTRY is not proof of a root: a `.git` FILE placed under
    // REPOS_ROOT points at another repository entirely, and adopting it would
    // key this session's approvals to that other repo. Only git can settle it.
    let top: string;
    try {
      top = await topLevel(repo);
    } catch (err) {
      return {
        ok: false,
        problem: "worktree-owner-unknown",
        detail: `git could not confirm ${repo} is its own working-tree root: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (pathRelation(top, repo) !== "same") {
      return {
        ok: false,
        problem: "worktree-owner-mismatch",
        detail: `${repo} is not its own working-tree root — git reports ${top}`,
      };
    }
    // A branch on a local-mode record means the two disagree about what this
    // session is. Guessing which one is right is how a worktree gets orphaned or
    // a checkout gets deleted, so refuse and let a human look.
    if (b.branch) {
      return {
        ok: false,
        problem: "local-has-branch",
        detail: `local mode must not carry a worktree branch (got \`${b.branch}\`)`,
      };
    }
    return { ok: true };
  }

  if (!isStrictlyInside(work, canon(deps.worktreeRoot))) {
    return {
      ok: false,
      problem: "worktree-outside-root",
      detail: `${work} is not inside the worktree root (${deps.worktreeRoot})`,
    };
  }
  if (!b.branch) {
    return { ok: false, problem: "worktree-no-branch", detail: `${work} has no recorded branch` };
  }
  let actual: string;
  try {
    actual = await owner(work);
  } catch (err) {
    return {
      ok: false,
      problem: "worktree-owner-unknown",
      detail: `git could not say which repo owns ${work}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (pathRelation(actual, repo) !== "same") {
    return {
      ok: false,
      problem: "worktree-owner-mismatch",
      detail: `${work} belongs to ${actual}, but the binding claims ${repo}`,
    };
  }
  return { ok: true };
}

/** One honest sentence per refusal, for a Discord reply or a startup notice. */
export function describeBindingProblem(p: BindingProblem): string {
  switch (p) {
    case "repo-outside-root":
      return "這個 repo 不在 `REPOS_ROOT` 底下";
    case "repo-not-git":
      return "這個目錄不是 git repo";
    case "local-workdir-mismatch":
      return "local 模式的工作目錄與 repo 不一致";
    case "local-has-branch":
      return "local 模式不該帶 worktree 分支";
    case "worktree-outside-root":
      return "worktree 不在預期的 worktree 目錄底下";
    case "worktree-no-branch":
      return "worktree 沒有記錄分支";
    case "worktree-owner-mismatch":
      return "這個 worktree 屬於另一個 repo";
    case "worktree-owner-unknown":
      return "無法向 git 確認這個 worktree 屬於哪個 repo";
  }
}

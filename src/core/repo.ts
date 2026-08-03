import path from "node:path";
import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { stateDir, worktreeRoot } from "./paths.js";

/**
 * Repository-root policy: which directories a session may be pointed at.
 *
 * v1 had ONE `CONTROLLED_REPO_PATH`. Multi-repo replaces it with a `REPOS_ROOT`
 * that *contains* repos, which moves the security boundary: it is no longer
 * "this exact directory" but "anything under this root that is a git
 * working-tree root". Everything that decides where an agent may work goes
 * through this module, so there is exactly one definition of that boundary.
 *
 * NOTE: this is policy/hygiene, not a sandbox. In v1 (lab-only) the agent can
 * still escape a path via shell/symlink; real isolation is the controller/worker
 * split tracked separately.
 */

/**
 * The OS's canonical name for an existing path. Throws if it does not exist.
 *
 * `realpathSync.native`, NOT `realpathSync`: only the native one expands Windows
 * 8.3 short names. Measured on Windows —
 * `realpathSync('C:\\PROGRA~1')` → `C:\PROGRA~1`,
 * `realpathSync.native('C:\\PROGRA~1')` → `C:\Program Files`.
 *
 * That is not a curiosity. `os.tmpdir()` on a GitHub Windows runner is
 * `C:\Users\RUNNER~1\...` while git reports `C:\Users\runneradmin\...` for the
 * same directory, so a binding proof built on the plain version compares two
 * names for one directory, finds them different, and refuses EVERY session on
 * such a machine. CI caught exactly that; a dev box whose paths are all short
 * enough never will.
 */
export function canonicalPath(p: string): string {
  return realpathSync.native(p);
}

/** Canonical name if the path exists, otherwise the resolved input. For
 *  comparisons that must not throw on a path that has been deleted. */
export function canonicalPathOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** How two paths relate, computed on canonicalised, OS-case-folded paths. */
export type PathRelation = "same" | "a-inside-b" | "b-inside-a" | "disjoint";

/**
 * Case-fold ONLY on Windows.
 *
 * Lowercasing unconditionally is a real defect on Linux, where `/srv/Repos` and
 * `/srv/repos` are DIFFERENT directories: folding them makes a disjointness
 * check report a containment that does not exist. CI runs Ubuntu, so this is
 * exercised.
 */
function fold(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** Strip trailing separators so `C:\x\` and `C:\x` compare equal, without ever
 *  stripping a root's own separator (`C:\`, `/`). */
function trimTrailingSep(p: string): string {
  const parsed = path.parse(p);
  if (p === parsed.root) return p;
  return p.replace(/[\\/]+$/, "") || parsed.root;
}

/**
 * `path.relative` is used rather than a string prefix test because a prefix test
 * claims `C:\Source\Repos-evil` is inside `C:\Source\Repos` — the classic
 * separator-boundary bug. `relative` returns `..\Repos-evil` there.
 *
 * BOTH sides are canonicalised first. Comparing a canonical path against a
 * merely-resolved one is how a security check fails OPEN: on a machine where a
 * path component has an 8.3 short name, `resolveReposRoot` canonicalised its
 * input to `C:\Users\runneradmin\...` and compared it against a trust-store path
 * still spelled `C:\Users\RUNNER~1\...`, decided they were disjoint, and
 * accepted a root that in fact contained the approval store. CI found it; a
 * machine with only long paths never would.
 */
export function pathRelation(a: string, b: string): PathRelation {
  const fa = fold(trimTrailingSep(canonicalPathOr(a)));
  const fb = fold(trimTrailingSep(canonicalPathOr(b)));
  if (fa === fb) return "same";
  const aFromB = path.relative(fb, fa);
  if (aFromB && !aFromB.startsWith("..") && !path.isAbsolute(aFromB)) return "a-inside-b";
  const bFromA = path.relative(fa, fb);
  if (bFromA && !bFromA.startsWith("..") && !path.isAbsolute(bFromA)) return "b-inside-a";
  return "disjoint";
}

/** True when `child` is strictly inside `parent` (not equal to it). */
export function isStrictlyInside(child: string, parent: string): boolean {
  return pathRelation(child, parent) === "a-inside-b";
}

/**
 * A git *working-tree root* has a `.git` entry — a directory for a normal clone,
 * a FILE for a linked worktree, which is why this tests existence rather than
 * `isDirectory`. A subdirectory of a repo has none, so this also enforces "root".
 *
 * Deliberately filesystem-only, no `git` subprocess:
 *  - `isGitRepo()` (worktree.ts) answers a DIFFERENT question — it is true for
 *    every descendant of a repo, which is exactly wrong for "is this candidate
 *    its own repo?";
 *  - the installer mirrors this rule (`scripts/lib/setup-core.mjs`) before
 *    `npm install` has run and without assuming `git` is on PATH, and a mirror
 *    that cannot be written the same way is a mirror that drifts.
 */
export function isGitWorkTreeRoot(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

/** The nearest ancestor of `dir` (inclusive) that is a git working-tree root, or
 *  undefined. Mirrors git's own upward discovery, without a subprocess.
 *
 *  Used for DIAGNOSIS only — see `resolveReposRoot` for why being inside an
 *  outer repo is not itself disqualifying. */
export function enclosingRepo(dir: string): string | undefined {
  let cur = path.resolve(dir);
  for (;;) {
    if (isGitWorkTreeRoot(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

export interface ReposRootDeps {
  /** The bot's own trust store (approvals.json, session store, instance lock). */
  stateDir: string;
  /** Where per-session worktrees are created. */
  worktreeRoot: string;
}

/**
 * Resolve and validate `REPOS_ROOT` — the directory that CONTAINS the repos a
 * session may be bound to. Returns the canonical absolute path.
 *
 * The rules, and the failure each one prevents:
 *
 * 1. **Absolute.** A relative path silently means a different directory
 *    depending on the process's cwd, and this value defines a security boundary.
 *    This also rejects Windows drive-relative `C:foo`, which `path.isAbsolute`
 *    correctly reports as NOT absolute.
 * 2. **Exists, is a directory**, canonicalised via `realpath` so a junction or
 *    symlink cannot make later comparisons disagree with the OS.
 * 3. **Not itself a git working-tree root.** This is the exact inverse of the
 *    rule the single-repo installer enforced: `CONTROLLED_REPO_PATH` had to BE a
 *    repo, `REPOS_ROOT` must CONTAIN them. Catching it here turns the commonest
 *    migration mistake (pasting the old value) into one clear sentence instead
 *    of an empty repo picker.
 *
 *    Deliberately NOT extended to "anywhere inside an outer repo", even though
 *    that was raised in review as the dangerous case. Measured on git 2.x: from
 *    a candidate that has its OWN `.git`, `rev-parse --show-toplevel` returns
 *    that candidate and `--git-common-dir` its own `.git` — the outer repo never
 *    wins, so approval keys and `git worktree add` still target the right repo.
 *    The outer repo only wins for a candidate with NO `.git`, and
 *    `resolveRepoWithinRoot` already refuses those. Banning the ancestor case
 *    would buy nothing and would break the very common setup of a home directory
 *    that is itself a dotfiles repo with `~/Repos` underneath it.
 * 4. **Disjoint from the trust store, in BOTH directions.** The worktree root
 *    lives outside `stateDir()` so no agent's cwd has the trust store as an
 *    ancestor; multi-repo opens that hole from two sides.
 *    `REPOS_ROOT=C:\Users\me` would make `~/.discord-copilot-sdk` a bindable
 *    "repo"; `REPOS_ROOT=~/.discord-copilot-sdk/repos` would put every agent's
 *    cwd *underneath* the trust store. Both are refused.
 */
export function resolveReposRoot(input: string, deps?: Partial<ReposRootDeps>): string {
  if (!input || !path.isAbsolute(input)) {
    throw new Error(
      `REPOS_ROOT must be an absolute path (got: ${input || "(empty)"}). ` +
        `On Windows a drive-relative path like C:repos is NOT absolute — write C:\\repos.`
    );
  }
  if (!existsSync(input)) {
    throw new Error(`REPOS_ROOT does not exist: ${input}`);
  }
  const real = canonicalPath(input);
  if (!statSync(real).isDirectory()) {
    throw new Error(`REPOS_ROOT is not a directory: ${real}`);
  }
  const enclosing = enclosingRepo(real);
  if (enclosing === real) {
    throw new Error(
      `REPOS_ROOT must be a directory that CONTAINS repos, but ${real} is itself a git repository. ` +
        `Point it at the parent (e.g. C:\\Source\\Repos, not C:\\Source\\Repos\\my-repo).`
    );
  }
  const checks: ReadonlyArray<readonly [string, string]> = [
    ["the bot's state directory", deps?.stateDir ?? stateDir()],
    ["the per-session worktree directory", deps?.worktreeRoot ?? worktreeRoot()],
  ];
  for (const [label, other] of checks) {
    const rel = pathRelation(real, other);
    if (rel === "same" || rel === "b-inside-a") {
      throw new Error(
        `REPOS_ROOT ${real} contains ${label} (${other}). An agent could then be pointed at the ` +
          `bot's own approval store. Pick a root that does not contain it.`
      );
    }
    if (rel === "a-inside-b") {
      throw new Error(
        `REPOS_ROOT ${real} is inside ${label} (${other}). Every agent's working directory would ` +
          `then have the bot's trust store as an ancestor. Pick a root outside it.`
      );
    }
  }
  return real;
}

/** Reject anything that is not a single, plain directory entry. Separators are
 *  refused outright rather than normalised, because `/repo list` and the
 *  autocomplete are single-level: a nested name could name something the
 *  operator was never shown. */
export function repoNameProblem(name: string): string | undefined {
  if (!name || !name.trim()) return "a repo name is required";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "contains control characters";
  if (name.includes("/") || name.includes("\\")) return "must be a single name, not a path";
  if (path.isAbsolute(name)) return "must be a name under REPOS_ROOT, not an absolute path";
  if (name === "." || name === ".." || name.includes("..")) return "must not contain '..'";
  return undefined;
}

/**
 * THE binding gate: turn an operator-supplied repo NAME into the canonical
 * absolute path of a repo inside `root`, or throw.
 *
 * Every path that binds a thread to a repo (`/repo set`, `/repo clone`,
 * `/repo new`, `/new repo:`, and a persisted record being resumed) must come
 * through here. `path.join` alone is NOT safe — it happily accepts `..` and
 * absolute inputs — and neither is a string prefix check on the joined result,
 * because a junction *inside* the root can point anywhere. So both sides are
 * resolved with the OS realpath and compared with `path.relative`.
 *
 * Also requires the target to be a git working-tree root, which seam-acp's
 * equivalent does not: `worktree` mode literally cannot work without it, and
 * `local` mode on a non-repo silently loses every protection `/end` relies on
 * (there is no `git status` that could prove the tree is clean).
 */
export function resolveRepoWithinRoot(root: string, name: string): string {
  const problem = repoNameProblem(name);
  if (problem) throw new Error(`Invalid repo name \`${name}\`: ${problem}.`);
  let realRoot: string;
  try {
    realRoot = canonicalPath(root);
  } catch {
    throw new Error(`REPOS_ROOT is not accessible: ${root}`);
  }
  const candidate = path.join(realRoot, name);
  if (!existsSync(candidate)) {
    throw new Error(`No such repo under REPOS_ROOT: \`${name}\`. Use /repo list to see what is there.`);
  }
  let real: string;
  try {
    real = canonicalPath(candidate);
  } catch {
    throw new Error(`Could not resolve \`${name}\` under REPOS_ROOT.`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`\`${name}\` is not a directory.`);
  }
  if (!isStrictlyInside(real, realRoot)) {
    throw new Error(
      `\`${name}\` resolves to ${real}, which is outside REPOS_ROOT (${realRoot}). ` +
        `A link inside the root may not point out of it.`
    );
  }
  if (!isGitWorkTreeRoot(real)) {
    throw new Error(
      `\`${name}\` is not a git repository (no .git entry). Create one with \`/repo new ${name}\`, ` +
        `or clone into REPOS_ROOT with \`/repo clone\`.`
    );
  }
  return real;
}

/**
 * The repos that may be bound, as plain names, sorted.
 *
 * Uses the SAME predicate as `resolveRepoWithinRoot` — including the realpath
 * containment check — so what is listed is exactly what can be bound. Listing
 * something the binding gate then refuses is its own bug report.
 *
 * Single level, dot-directories skipped (which is also what keeps `.staging-*`
 * clone scratch directories out of the picker).
 */
export function listRepos(root: string): string[] {
  let realRoot: string;
  try {
    realRoot = canonicalPath(root);
  } catch {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(realRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    // `withFileTypes` uses lstat semantics, so a symlinked repo reports
    // isSymbolicLink(), not isDirectory(). Considering both is what keeps this
    // listing consistent with the binding gate, which follows links.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      resolveRepoWithinRoot(realRoot, e.name);
      out.push(e.name);
    } catch {
      /* not bindable — deliberately invisible rather than listed-but-refused */
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

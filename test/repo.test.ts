import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveReposRoot,
  resolveRepoWithinRoot,
  listRepos,
  pathRelation,
  isStrictlyInside,
  isGitWorkTreeRoot,
  enclosingRepo,
  repoNameProblem,
  canonicalPath,
} from "../src/core/repo.js";

let tmp: string;
let root: string;
/** Trust-store stand-ins, kept OUTSIDE `root` so the disjointness rule passes
 *  unless a test deliberately breaks it. */
let deps: { stateDir: string; worktreeRoot: string };

/** Make `name` under `root` look like a git working-tree root. */
function makeRepo(parent: string, name: string, gitAsFile = false): string {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  if (gitAsFile) writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
  else mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "dcs-repo-"));
  root = path.join(tmp, "Repos");
  mkdirSync(root, { recursive: true });
  deps = {
    stateDir: path.join(tmp, "state"),
    worktreeRoot: path.join(tmp, "state-worktrees"),
  };
  mkdirSync(deps.stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pathRelation", () => {
  it("does NOT treat a sibling with a shared prefix as contained", () => {
    // The bug a plain string-prefix check has: `C:\Source\Repos-evil`
    // startsWith `C:\Source\Repos`.
    expect(pathRelation("/srv/Repos-evil", "/srv/Repos")).toBe("disjoint");
    expect(isStrictlyInside("/srv/Repos-evil", "/srv/Repos")).toBe(false);
    expect(isStrictlyInside("/srv/Repos/a", "/srv/Repos")).toBe(true);
  });

  it("reports containment in both directions, and equality as `same`", () => {
    expect(pathRelation("/a/b", "/a")).toBe("a-inside-b");
    expect(pathRelation("/a", "/a/b")).toBe("b-inside-a");
    expect(pathRelation("/a", "/a")).toBe("same");
    expect(pathRelation("/a/", "/a")).toBe("same"); // trailing separator
  });

  it("case-folds only on Windows — on Linux differing case is a DIFFERENT dir", () => {
    const rel = pathRelation("/srv/Repos", "/srv/repos");
    if (process.platform === "win32") expect(rel).toBe("same");
    else expect(rel).toBe("disjoint");
  });
});

describe("isGitWorkTreeRoot / enclosingRepo", () => {
  it("accepts a `.git` FILE (a linked worktree), not just a directory", () => {
    const wt = makeRepo(tmp, "linked", true);
    expect(isGitWorkTreeRoot(wt)).toBe(true);
  });

  it("is false for a subdirectory of a repo, but enclosingRepo finds the root", () => {
    const repo = makeRepo(tmp, "proj");
    const sub = path.join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(isGitWorkTreeRoot(sub)).toBe(false);
    expect(enclosingRepo(sub)).toBe(repo);
  });

  it("finds the NEAREST repo, and walks past directories that are not repos", () => {
    // Deliberately not asserting `undefined` for a tmpdir path: whether anything
    // above tmpdir is a repo is machine state (a home directory that is a
    // dotfiles repo is common — this machine has one), and pinning it would make
    // the suite pass or fail for reasons that have nothing to do with the code.
    const outer = makeRepo(tmp, "outer");
    const inner = makeRepo(path.join(outer, "nested", "deeper"), "inner");
    expect(enclosingRepo(path.join(inner, "src"))).toBe(inner);
    expect(enclosingRepo(path.join(outer, "nested"))).toBe(outer);
    // Our own non-repo scratch dir must not be reported as a repo.
    expect(enclosingRepo(root)).not.toBe(root);
  });
});

describe("resolveReposRoot", () => {
  it("accepts a plain directory that merely CONTAINS repos", () => {
    // Exactly the shape the single-repo installer used to REJECT.
    makeRepo(root, "career-ops");
    expect(resolveReposRoot(root, deps)).toBe(canonicalPath(root));
  });

  it("rejects a relative path and a Windows drive-relative path", () => {
    expect(() => resolveReposRoot("relative/path", deps)).toThrow(/absolute/i);
    expect(() => resolveReposRoot("C:repos", deps)).toThrow(/absolute/i);
  });

  it("rejects a path that does not exist, or is not a directory", () => {
    expect(() => resolveReposRoot(path.join(tmp, "nope"), deps)).toThrow(/does not exist/i);
    const f = path.join(tmp, "afile");
    writeFileSync(f, "x");
    expect(() => resolveReposRoot(f, deps)).toThrow(/not a directory/i);
  });

  it("rejects a root that is ITSELF a git repo, and says what to point at instead", () => {
    // The exact inverse of the single-repo rule, and the commonest migration
    // mistake: pasting the old CONTROLLED_REPO_PATH value straight in.
    const repo = makeRepo(tmp, "my-repo");
    expect(() => resolveReposRoot(repo, deps)).toThrow(/itself a git repository/i);
  });

  it("ALLOWS a root inside an outer repo — git resolves an inner repo to itself", () => {
    // Raised in review as the dangerous case. Measured (git 2.x): from a
    // candidate with its own .git, `rev-parse --show-toplevel` returns that
    // candidate, so the outer repo never becomes the approval key or the
    // worktree target. Banning it would break the very common "home directory is
    // a dotfiles repo" setup — which is exactly what this machine has, and is
    // why every tmpdir-based test here would otherwise fail.
    const outer = makeRepo(tmp, "outer");
    const nested = path.join(outer, "Repos");
    mkdirSync(nested, { recursive: true });
    expect(() => resolveReposRoot(nested, deps)).not.toThrow();
  });

  it("still refuses a candidate with no .git of its own — that IS the outer-repo hazard", () => {
    // The narrow case where the outer repo really would win: a plain
    // subdirectory resolves to the OUTER .git. The binding gate closes it.
    const outer = makeRepo(tmp, "outer2");
    const nested = path.join(outer, "Repos");
    mkdirSync(path.join(nested, "plain"), { recursive: true });
    expect(() => resolveRepoWithinRoot(nested, "plain")).toThrow(/not a git repository/i);
  });

  it("rejects a root that CONTAINS the trust store (agent could be bound to it)", () => {
    // e.g. REPOS_ROOT=C:\Users\me makes ~/.discord-copilot-sdk a bindable repo.
    const home = tmp;
    expect(() => resolveReposRoot(home, deps)).toThrow(/contains the bot's state directory/i);
  });

  it("rejects a root INSIDE the trust store (the other direction)", () => {
    // e.g. REPOS_ROOT=~/.discord-copilot-sdk/repos puts every agent cwd under it.
    const inside = path.join(deps.stateDir, "repos");
    mkdirSync(inside, { recursive: true });
    expect(() => resolveReposRoot(inside, deps)).toThrow(/is inside the bot's state directory/i);
  });

  it("rejects a root that contains, or sits inside, the worktree directory", () => {
    mkdirSync(deps.worktreeRoot, { recursive: true });
    const inside = path.join(deps.worktreeRoot, "repos");
    mkdirSync(inside, { recursive: true });
    expect(() => resolveReposRoot(inside, deps)).toThrow(/worktree directory/i);
    // …and the containing direction, with the state dir moved out of the way so
    // it is unambiguously the worktree rule that fires.
    expect(() =>
      resolveReposRoot(tmp, { stateDir: path.join(tmp, "..", "elsewhere-state"), worktreeRoot: deps.worktreeRoot })
    ).toThrow(/contains the per-session worktree directory/i);
  });
});

describe("resolveRepoWithinRoot (the binding gate)", () => {
  it("resolves a repo by name to its canonical path", () => {
    const repo = makeRepo(root, "career-ops");
    expect(resolveRepoWithinRoot(root, "career-ops")).toBe(canonicalPath(repo));
  });

  it("refuses traversal, absolute paths and separators outright", () => {
    for (const bad of ["..", "../escape", "a/b", "a\\b", "/etc", "C:\\Windows", ".", ""]) {
      expect(() => resolveRepoWithinRoot(root, bad)).toThrow();
    }
  });

  it("refuses control characters in a name", () => {
    expect(repoNameProblem("ok\u0007name")).toMatch(/control/i);
    expect(() => resolveRepoWithinRoot(root, "ok\u0000name")).toThrow(/control/i);
  });

  it("refuses a directory under the root that is NOT a git repo", () => {
    mkdirSync(path.join(root, "just-a-folder"), { recursive: true });
    expect(() => resolveRepoWithinRoot(root, "just-a-folder")).toThrow(/not a git repository/i);
  });

  it("refuses a name that does not exist, and points at /repo list", () => {
    expect(() => resolveRepoWithinRoot(root, "ghost")).toThrow(/No such repo/i);
  });

  it("refuses a symlink INSIDE the root that points OUT of it", () => {
    // A plain string-prefix check on the joined path would accept this: the
    // joined path is under the root, only the RESOLVED path is not.
    const outside = makeRepo(tmp, "outside-repo");
    const link = path.join(root, "sneaky");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // no symlink privilege (unelevated Windows) — nothing to assert
    }
    expect(() => resolveRepoWithinRoot(root, "sneaky")).toThrow(/outside REPOS_ROOT/i);
  });
});

describe("canonicalPath (8.3 short names)", () => {
  it("uses realpathSync.NATIVE — the plain one does not expand short names", () => {
    // Pinned at source level because the difference is invisible on a dev box
    // whose paths are all short enough. CI caught it: `os.tmpdir()` on a GitHub
    // Windows runner is `C:\Users\RUNNER~1\...` while git reports
    // `C:\Users\runneradmin\...` for the same directory, so the plain version
    // compared two names for one directory, found them different, and made
    // `validateBinding` refuse EVERY session on that machine.
    const src = readFileSync(new URL("../src/core/repo.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function canonicalPath"));
    expect(body.slice(0, body.indexOf("}"))).toContain("realpathSync.native");
  });

  it("expands a real 8.3 name on Windows", () => {
    if (process.platform !== "win32" || !existsSync("C:\\PROGRA~1")) return;
    expect(canonicalPath("C:\\PROGRA~1")).not.toBe("C:\\PROGRA~1");
    expect(canonicalPath("C:\\PROGRA~1").toLowerCase()).toContain("program files");
  });

  it("is idempotent — canonicalising a canonical path changes nothing", () => {
    const once = canonicalPath(tmp);
    expect(canonicalPath(once)).toBe(once);
  });

  it("resolves a repo to the SAME string whichever name it is reached by", () => {
    // The property that actually matters: `validateBinding` compares a recorded
    // path against what git reports, and those two can be different names.
    const repo = makeRepo(root, "canon-me");
    const viaRoot = resolveRepoWithinRoot(root, "canon-me");
    expect(viaRoot).toBe(canonicalPath(repo));
  });
});

describe("listRepos", () => {
  it("lists only bindable git repos, sorted, skipping dot-directories", () => {
    makeRepo(root, "zebra");
    makeRepo(root, "alpha");
    mkdirSync(path.join(root, "not-a-repo"), { recursive: true });
    makeRepo(root, ".staging-abc123"); // clone scratch dir must stay invisible
    expect(listRepos(root)).toEqual(["alpha", "zebra"]);
  });

  it("lists exactly what the binding gate accepts — never more", () => {
    makeRepo(root, "good");
    mkdirSync(path.join(root, "bare"), { recursive: true });
    for (const name of listRepos(root)) {
      expect(() => resolveRepoWithinRoot(root, name)).not.toThrow();
    }
  });

  it("returns an empty list for a missing root rather than throwing", () => {
    expect(listRepos(path.join(tmp, "nothing-here"))).toEqual([]);
  });
});

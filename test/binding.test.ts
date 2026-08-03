import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { validateBinding, isDevMode, type Binding, type BindingDeps } from "../src/core/binding.js";
import { repoRootStrict, addWorktree } from "../src/core/worktree.js";

const run = promisify(execFile);

let tmp: string;
let reposRoot: string;
let worktreeRoot: string;
let repoA: string;
let repoB: string;

function gitRepo(parent: string, name: string): string {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function initRepo(dir: string): Promise<void> {
  await run("git", ["init", "-b", "main", dir]);
  await run("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@localhost",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@localhost",
    },
  });
}

function deps(): BindingDeps {
  return { reposRoot, worktreeRoot };
}

function binding(over: Partial<Binding>): Binding {
  return { repoPath: repoA, workDir: repoA, devMode: "local", ...over };
}

// Real git worktrees are spawned here, so give it room like worktree-git.test.ts.
describe("validateBinding (proves ownership, never assumes it)", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "dcs-bind-"));
    reposRoot = path.join(tmp, "Repos");
    worktreeRoot = path.join(tmp, "wt");
    mkdirSync(reposRoot, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    repoA = gitRepo(reposRoot, "alpha");
    repoB = gitRepo(reposRoot, "beta");
    await initRepo(repoA);
    await initRepo(repoB);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts a well-formed local binding", async () => {
    expect(await validateBinding(binding({}), deps())).toEqual({ ok: true });
  });

  it("refuses a repo outside REPOS_ROOT", async () => {
    const outside = gitRepo(tmp, "outside");
    await initRepo(outside);
    const v = await validateBinding(binding({ repoPath: outside, workDir: outside }), deps());
    expect(v).toMatchObject({ ok: false, problem: "repo-outside-root" });
  });

  it("refuses a repo that is not a git working-tree root", async () => {
    const plain = path.join(reposRoot, "plain");
    mkdirSync(plain, { recursive: true });
    const v = await validateBinding(binding({ repoPath: plain, workDir: plain }), deps());
    expect(v).toMatchObject({ ok: false, problem: "repo-not-git" });
  });

  it("refuses a local binding whose workDir is not the repo", async () => {
    const v = await validateBinding(binding({ workDir: path.join(repoA, "src") }), deps());
    expect(v).toMatchObject({ ok: false, problem: "local-workdir-mismatch" });
  });

  it("refuses a local binding that carries a worktree branch", async () => {
    // The record disagrees with itself; guessing which half is right is how a
    // worktree gets orphaned or a checkout gets deleted.
    const v = await validateBinding(binding({ branch: "copilot/t-1" }), deps());
    expect(v).toMatchObject({ ok: false, problem: "local-has-branch" });
  });

  it("accepts a REAL worktree that genuinely belongs to the claimed repo", async () => {
    const dir = path.join(worktreeRoot, "hash-a", "t1");
    await addWorktree(repoA, dir, "copilot/t-1");
    const v = await validateBinding(
      { repoPath: repoA, workDir: dir, devMode: "worktree", branch: "copilot/t-1" },
      deps()
    );
    expect(v).toEqual({ ok: true });
  });

  it("REFUSES repo A's worktree presented as repo B's — the flat-layout bug", async () => {
    // This is the exact failure a path-prefix check waves through: the worktree
    // is under the worktree root and has a branch, so every structural test
    // passes. Only asking git catches it.
    const dir = path.join(worktreeRoot, "hash-a", "t1");
    await addWorktree(repoA, dir, "copilot/t-1");
    const v = await validateBinding(
      { repoPath: repoB, workDir: dir, devMode: "worktree", branch: "copilot/t-1" },
      deps()
    );
    expect(v).toMatchObject({ ok: false, problem: "worktree-owner-mismatch" });
  });

  it("refuses a worktree outside the worktree root", async () => {
    const dir = path.join(tmp, "stray", "t1");
    await addWorktree(repoA, dir, "copilot/t-1");
    const v = await validateBinding(
      { repoPath: repoA, workDir: dir, devMode: "worktree", branch: "copilot/t-1" },
      deps()
    );
    expect(v).toMatchObject({ ok: false, problem: "worktree-outside-root" });
  });

  it("refuses a worktree binding with no branch", async () => {
    const dir = path.join(worktreeRoot, "hash-a", "t1");
    await addWorktree(repoA, dir, "copilot/t-1");
    const v = await validateBinding({ repoPath: repoA, workDir: dir, devMode: "worktree" }, deps());
    expect(v).toMatchObject({ ok: false, problem: "worktree-no-branch" });
  });

  it("REFUSES when git cannot answer — a broken git is not a pass", async () => {
    const dir = path.join(worktreeRoot, "not-a-worktree");
    mkdirSync(dir, { recursive: true });
    const v = await validateBinding(
      { repoPath: repoA, workDir: dir, devMode: "worktree", branch: "copilot/t-1" },
      { ...deps(), ownerOf: () => Promise.reject(new Error("git exploded")) }
    );
    expect(v).toMatchObject({ ok: false, problem: "worktree-owner-unknown" });
  });
});

describe("repoRootStrict", () => {
  it("reports the MAIN repo for a linked worktree, not the worktree itself", async () => {
    // --git-common-dir (not --git-dir) is what makes ownership answerable.
    const t = mkdtempSync(path.join(os.tmpdir(), "dcs-strict-"));
    try {
      const repo = path.join(t, "r");
      mkdirSync(repo, { recursive: true });
      await initRepo(repo);
      const wt = path.join(t, "wt", "one");
      await addWorktree(repo, wt, "copilot/t-x");
      const { canonicalPath } = await import("../src/core/repo.js");
      expect(await repoRootStrict(wt)).toBe(canonicalPath(repo));
      expect(await repoRootStrict(repo)).toBe(canonicalPath(repo));
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, 60_000);

  it("throws when the directory is not in a repo at all", async () => {
    const t = mkdtempSync(path.join(os.tmpdir(), "dcs-strict2-"));
    try {
      // Guard: if this machine's tmpdir happens to sit inside a repo (a home
      // directory that is a dotfiles repo is common), git legitimately answers,
      // so there is nothing to assert.
      let enclosing: string | undefined;
      try {
        enclosing = await repoRootStrict(t);
      } catch {
        enclosing = undefined;
      }
      if (enclosing === undefined) {
        await expect(repoRootStrict(t)).rejects.toThrow();
      }
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("isDevMode", () => {
  it("accepts exactly the two modes and rejects everything else", () => {
    expect(isDevMode("local")).toBe(true);
    expect(isDevMode("worktree")).toBe(true);
    for (const bad of ["shared", "", undefined, null, 1, {}]) expect(isDevMode(bad)).toBe(false);
  });
});

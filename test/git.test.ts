import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { gitDiffSummary } from "../src/core/git.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** These tests shell out to real `git`; skip gracefully if git is unavailable. */
function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const git = hasGit();
const d = git ? describe : describe.skip;

d("gitDiffSummary (P5)", () => {
  let repo: string;
  const run = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "dp-git-"));
    run("init", "-b", "main");
    run("config", "user.email", "t@t.t");
    run("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    run("add", "a.txt");
    run("commit", "-m", "init");
  });

  afterAll(() => {
    if (repo) rmSync(repo, { force: true, recursive: true });
  });

  it("reports 'no changes' on a clean tree", async () => {
    const out = await gitDiffSummary(repo, false);
    expect(out).toContain("沒有變更");
  });

  it("summarizes an unstaged modification", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    const out = await gitDiffSummary(repo, false);
    expect(out).toContain("a.txt");
    expect(out).toContain("unstaged");
  });

  it("counts untracked files in the unstaged summary", async () => {
    writeFileSync(join(repo, "b.txt"), "new\n");
    const out = await gitDiffSummary(repo, false);
    expect(out).toMatch(/未追蹤/);
  });

  it("staged view shows only staged changes", async () => {
    run("add", "a.txt");
    const out = await gitDiffSummary(repo, true);
    expect(out).toContain("staged");
    expect(out).toContain("a.txt");
  });
});

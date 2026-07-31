import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktree, removeWorktreeIfClean } from "../src/core/worktree.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> => exec("git", args, { cwd });

let repo: string;

beforeAll(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dcs-wt-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "config", "commit.gpgsign", "false");
  await fs.promises.writeFile(path.join(repo, "a.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "one");
});

afterAll(async () => {
  await fs.promises.rm(repo, { recursive: true, force: true }).catch(() => {});
});

/** Fresh worktree on its own branch, the way a session gets one. */
async function makeWorktree(name: string): Promise<{ dir: string; branch: string }> {
  const dir = path.join(repo, "..", `${path.basename(repo)}-${name}`);
  const branch = `copilot/t-${name}`;
  await addWorktree(repo, dir, branch);
  return { dir, branch };
}

// Real git worktrees, so several subprocesses per test — see the note in
// app-reclaim.test.ts about CI being several times slower than a local run.
describe("removeWorktreeIfClean", { timeout: 60_000 }, () => {
  it("removes a clean worktree and keeps its branch", async () => {
    const { dir, branch } = await makeWorktree("clean");
    expect(await removeWorktreeIfClean(repo, dir, branch)).toBe("removed");
    expect(fs.existsSync(dir)).toBe(false);
    const { stdout } = await git(repo, "branch", "--list", branch);
    expect(stdout.trim()).toContain(branch); // branch survives — commits stay reachable
  });

  it("keeps a worktree whose only local content is gitignored", async () => {
    // Plain `git status --porcelain` hides ignored paths, so a tree holding only
    // a .env would read clean and be deleted recursively.
    const { dir, branch } = await makeWorktree("ignored");
    await fs.promises.writeFile(path.join(dir, ".gitignore"), ".env\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "ignore env");
    await fs.promises.writeFile(path.join(dir, ".env"), "SECRET=1\n");
    expect(await removeWorktreeIfClean(repo, dir, branch)).toBe("kept-dirty");
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(true);
    await git(repo, "worktree", "remove", "--force", dir);
  });

  it("reports an ALREADY-ABSENT directory instead of failing forever", async () => {
    // A crash between removing the tree and removing the record, or an operator
    // who ran `git worktree remove` by hand, leaves a record pointing at nothing.
    // Reporting that as "failed" makes callers keep the record for ever, since
    // every later attempt fails the same way — a leak with no way out.
    const { dir, branch } = await makeWorktree("absent");
    await git(repo, "worktree", "remove", "--force", dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(await removeWorktreeIfClean(repo, dir, branch)).toBe("already-absent");
  });

  it("REFUSES a detached HEAD carrying commits no branch points at", async () => {
    // git status is clean, but HEAD lives only in the worktree's own HEAD file.
    // Removing the tree drops that ref and the commits become unreachable and
    // GC-eligible — the branch surviving proves nothing, it never moved.
    const { dir, branch } = await makeWorktree("detached");
    await git(dir, "checkout", "-q", "--detach");
    await fs.promises.writeFile(path.join(dir, "b.txt"), "work only here\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "unreferenced work");
    const { stdout: clean } = await git(dir, "status", "--porcelain", "--ignored=matching");
    expect(clean.trim()).toBe(""); // git itself calls this clean
    expect(await removeWorktreeIfClean(repo, dir, branch)).toBe("kept-detached");
    expect(fs.existsSync(dir)).toBe(true);
    await git(repo, "worktree", "remove", "--force", dir);
  });

  it("REFUSES when HEAD moved to a different branch than the record's", async () => {
    // The record's branch is what we promise survives. If the agent switched
    // branches, removing the tree can strand whatever it built.
    const { dir, branch } = await makeWorktree("switched");
    await git(dir, "checkout", "-q", "-b", "somewhere-else");
    expect(await removeWorktreeIfClean(repo, dir, branch)).toBe("kept-detached");
    expect(fs.existsSync(dir)).toBe(true);
    await git(repo, "worktree", "remove", "--force", dir);
  });

  it("still removes a clean worktree when no branch was recorded", async () => {
    // Back-compat: v1 records have no branch, so there is nothing to compare.
    const { dir } = await makeWorktree("nobranch");
    expect(await removeWorktreeIfClean(repo, dir)).toBe("removed");
    expect(fs.existsSync(dir)).toBe(false);
  });
});

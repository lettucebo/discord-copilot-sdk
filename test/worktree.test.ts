import { describe, it, expect } from "vitest";
import path from "node:path";
import { worktreeBranch, worktreePath, repoSlug } from "../src/core/worktree.js";

describe("worktreeBranch / worktreePath", () => {
  it("derives a stable, namespaced branch from the thread id", () => {
    expect(worktreeBranch("123456")).toBe("copilot/t-123456");
  });

  it("keeps ids that are already safe intact, and sanitises anything else", () => {
    // Discord ids are numeric, but a branch name must never be able to inject
    // git refspec syntax.
    expect(worktreeBranch("abc-123_x")).toBe("copilot/t-abc-123_x");
    expect(worktreeBranch("a/../../b")).toBe("copilot/t-a-b");
    expect(worktreeBranch("a b~c^d:e?f*g[h]")).toBe("copilot/t-a-b-c-d-e-f-g-h");
  });

  it("never produces an empty or dot-only branch segment", () => {
    expect(worktreeBranch("")).toBe("copilot/t-session");
    expect(worktreeBranch("...")).toBe("copilot/t-session");
  });

  it("puts each thread's worktree under a per-REPO directory", () => {
    // The repo segment is what stops a rebound thread from silently reusing the
    // checkout of the repo it was moved away from: `addWorktree` adopts an
    // existing directory, so one path per (repo, thread) is the invariant.
    const root = path.join(path.sep, "state", "worktrees");
    const p = worktreePath(root, path.join(path.sep, "Source", "Repos", "alpha"), "123456");
    expect(p.startsWith(root)).toBe(true);
    expect(p.endsWith(`${path.sep}123456`)).toBe(true);
    expect(path.dirname(p)).not.toBe(root); // there IS a repo level in between
  });

  it("gives DIFFERENT directories to the same thread on different repos", () => {
    const root = path.join(path.sep, "state", "worktrees");
    const a = worktreePath(root, path.join(path.sep, "Source", "Repos", "alpha"), "t1");
    const b = worktreePath(root, path.join(path.sep, "Source", "Repos", "beta"), "t1");
    expect(a).not.toBe(b);
  });

  it("gives the SAME directory for the same repo + thread (idempotent resume)", () => {
    const root = path.join(path.sep, "state", "worktrees");
    const repo = path.join(path.sep, "Source", "Repos", "alpha");
    expect(worktreePath(root, repo, "t1")).toBe(worktreePath(root, repo, "t1"));
  });

  it("cannot be escaped by a hostile thread id (no path traversal)", () => {
    const root = path.join(path.sep, "state", "worktrees");
    const p = worktreePath(root, path.join(path.sep, "Source", "Repos", "alpha"), "../../evil");
    expect(p.includes("..")).toBe(false);
    expect(p.startsWith(root)).toBe(true);
  });
});

describe("repoSlug", () => {
  // Paths are built with path.join, not written as literals: on Linux a
  // backslash is an ordinary filename character, so "C:\\Source\\Repos\\x" is
  // ONE segment and `path.basename` returns the whole string. CI caught that.
  const under = (...segs: string[]): string => path.join(path.sep, "Source", "Repos", ...segs);

  it("keeps the repo name readable and appends a hash of the full path", () => {
    // Readability matters: the leftover-worktree report exists to tell a human
    // which project a stray checkout belongs to.
    const slug = repoSlug(under("career-ops"));
    expect(slug.startsWith("career-ops-")).toBe(true);
    expect(slug).toMatch(/^career-ops-[0-9a-f]{10}$/);
  });

  it("distinguishes same-named repos in different roots", () => {
    expect(repoSlug(path.join(path.sep, "a", "proj"))).not.toBe(repoSlug(path.join(path.sep, "b", "proj")));
  });

  it("produces a filesystem-safe segment even for an awkward name", () => {
    expect(repoSlug(under("weird name!"))).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

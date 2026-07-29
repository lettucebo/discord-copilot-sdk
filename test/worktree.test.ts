import { describe, it, expect } from "vitest";
import { worktreeBranch, worktreePath, chooseIsolation } from "../src/core/worktree.js";

describe("chooseIsolation", () => {
  it("uses a worktree when the controlled path is a git repo", () => {
    expect(chooseIsolation({ isGitRepo: true, configured: undefined })).toBe("worktree");
  });

  it("falls back to the shared tree when it is NOT a git repo", () => {
    // git worktree is simply unavailable there — there is no third option.
    expect(chooseIsolation({ isGitRepo: false, configured: undefined })).toBe("shared");
  });

  it("honours an explicit `shared` even in a git repo", () => {
    expect(chooseIsolation({ isGitRepo: true, configured: "shared" })).toBe("shared");
  });

  it("REFUSES an explicit `worktree` when it is impossible, rather than pretending", () => {
    // Silently running shared while the operator asked for isolation is the one
    // outcome that could lose their work without warning.
    expect(chooseIsolation({ isGitRepo: false, configured: "worktree" })).toBe("impossible");
  });
});

describe("worktreeBranch / worktreePath", () => {  it("derives a stable, namespaced branch from the thread id", () => {
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

  it("puts each thread's worktree in its own directory under the given root", () => {
    const p = worktreePath("C:\\state\\worktrees", "123456");
    expect(p.startsWith("C:\\state\\worktrees")).toBe(true);
    expect(p.endsWith("123456")).toBe(true);
  });

  it("cannot be escaped by a hostile thread id (no path traversal)", () => {
    const p = worktreePath("C:\\state\\worktrees", "../../evil");
    expect(p.includes("..")).toBe(false);
    expect(p.startsWith("C:\\state\\worktrees")).toBe(true);
  });
});

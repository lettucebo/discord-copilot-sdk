import { describe, it, expect } from "vitest";

// TEMPORARY PROBE TEST — intentionally fails to prove branch protection blocks
// merging on red status checks. This branch/commit is disposable; PR will be
// closed without merge and the branch deleted.
describe("branch-protection-probe", () => {
  it("intentionally fails to trigger red CI status", () => {
    expect(1 + 1).toBe(3);
  });
});

import { describe, it, expect } from "vitest";
import { ApprovalPolicy, commandExecutable } from "../src/core/approval-policy.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const tmpFile = (): string => join(tmpdir(), `dp-approvals-${Math.random()}.json`);

describe("commandExecutable", () => {
  it("takes the first whitespace-delimited token", () => {
    expect(commandExecutable("git --no-pager status")).toBe("git");
    expect(commandExecutable("  npm run build ")).toBe("npm");
    expect(commandExecutable("")).toBe("");
  });
});

describe("ApprovalPolicy", () => {
  it("session approval is case-insensitive and requires ALL executables", () => {
    const p = new ApprovalPolicy(tmpFile());
    expect(p.isApproved("s1", "/repo", ["git"])).toBe(false);
    p.approveForSession("s1", "GIT");
    expect(p.isApproved("s1", "/repo", ["git"])).toBe(true);
    expect(p.isApproved("s1", "/repo", ["git", "rm"])).toBe(false); // rm not approved
    expect(p.isApproved("s2", "/repo", ["git"])).toBe(false); // other session
    expect(p.isApproved("s1", "/repo", [])).toBe(false); // empty never approves
  });

  it("repo approval persists across instances (reload from disk)", () => {
    const f = tmpFile();
    try {
      const p1 = new ApprovalPolicy(f);
      p1.approveForRepo("/repo", "npm");
      const p2 = new ApprovalPolicy(f);
      expect(p2.isApproved("any", "/repo", ["npm"])).toBe(true);
      expect(p2.isApproved("any", "/other", ["npm"])).toBe(false); // different repo
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("clearSession drops only that session's in-memory approvals", () => {
    const p = new ApprovalPolicy(tmpFile());
    p.approveForSession("s1", "git");
    p.approveForSession("s2", "git");
    p.clearSession("s1");
    expect(p.isApproved("s1", "/repo", ["git"])).toBe(false);
    expect(p.isApproved("s2", "/repo", ["git"])).toBe(true);
  });
});

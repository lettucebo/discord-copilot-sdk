import { describe, it, expect } from "vitest";
import { ApprovalPolicy, commandExecutable } from "../src/core/approval-policy.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync, chmodSync } from "node:fs";

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

  it("exposes session + repo approvals and clears repo rules", () => {
    const f = tmpFile();
    try {
      const p = new ApprovalPolicy(f);
      p.approveForSession("s1", "GIT");
      p.approveForRepo("/repo", "npm");
      expect(p.sessionApprovals("s1")).toEqual(["git"]);
      expect(p.repoApprovals("/repo")).toEqual(["npm"]);
      expect(p.clearRepo("/repo")).toBe(true); // durable success
      expect(p.repoApprovals("/repo")).toEqual([]);
      expect(new ApprovalPolicy(f).repoApprovals("/repo")).toEqual([]); // persisted
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("clearRepo returns true when there is nothing to clear (trivially durable)", () => {
    const p = new ApprovalPolicy(tmpFile());
    expect(p.clearRepo("/nope")).toBe(true);
  });

  it("clearRepo reports FALSE (fail-closed, honest) when the disk write fails", () => {
    // Point the store file at an existing DIRECTORY so writeFileSync throws
    // (EISDIR/EPERM) — simulating a persistence failure on revocation.
    const dir = mkdtempSync(join(tmpdir(), "dp-approve-dir-"));
    try {
      const p = new ApprovalPolicy(dir);
      // Seed in memory (this write also fails, but that's fail-safe for a grant).
      p.approveForRepo("/repo", "npm");
      expect(p.repoApprovals("/repo")).toEqual(["npm"]); // in memory regardless
      const durable = p.clearRepo("/repo");
      expect(durable).toBe(false); // revocation could not be persisted
      expect(p.repoApprovals("/repo")).toEqual([]); // but memory IS cleared (fail-closed now)
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("approveForRepo reports FALSE when the rule could not be persisted", () => {
    // "Always (this repo)" promises the rule survives a restart. When the write
    // fails the rule is live for THIS process only, and saying nothing would
    // leave the operator believing a security decision is recorded when it is
    // not. The grant itself still applies in memory (fail-safe for a grant).
    const dir = mkdtempSync(join(tmpdir(), "dp-approve-nodisk-"));
    try {
      const p = new ApprovalPolicy(dir);
      expect(p.approveForRepo("/repo", "npm")).toBe(false);
      expect(p.repoApprovals("/repo")).toEqual(["npm"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("approveForRepo reports TRUE on a durable write and for an already-known rule", () => {
    const p = new ApprovalPolicy(tmpFile());
    expect(p.approveForRepo("/repo", "npm")).toBe(true);
    expect(p.approveForRepo("/repo", "npm")).toBe(true); // idempotent
    expect(p.approveForRepo("/repo", "   ")).toBe(false); // nothing to record
  });

  it("approveForRepo keeps reporting FALSE while the rule is in memory but not on disk", () => {
    // Regression: the already-present branch used to return true unconditionally
    // ("previously persisted"), which is exactly wrong after a FIRST grant whose
    // write failed — the rule is live for this process only, and the second call
    // would claim it is remembered across restarts.
    const dir = mkdtempSync(join(tmpdir(), "dp-approve-repeat-"));
    try {
      const p = new ApprovalPolicy(dir);
      expect(p.approveForRepo("/repo", "npm")).toBe(false);
      expect(p.approveForRepo("/repo", "npm")).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("clearRepo RETRIES persistence after a transient failure (no false success)", () => {
    // Regression: a first clear that fails to write must not let a SECOND clear
    // report success while the old rules still sit on disk. clearRepo always
    // re-attempts the write, so once the disk is writable again it truly clears.
    const f = tmpFile();
    try {
      const p = new ApprovalPolicy(f);
      p.approveForRepo("/repo", "npm"); // durably written (file has npm)
      chmodSync(f, 0o444); // read-only → next write fails
      expect(p.clearRepo("/repo")).toBe(false); // honest failure
      chmodSync(f, 0o644); // access restored
      expect(p.clearRepo("/repo")).toBe(true); // retry actually persists the cleared map
      expect(new ApprovalPolicy(f).repoApprovals("/repo")).toEqual([]); // durably gone on reload
    } finally {
      try {
        chmodSync(f, 0o644);
      } catch {
        /* ignore */
      }
      rmSync(f, { force: true });
    }
  });
});

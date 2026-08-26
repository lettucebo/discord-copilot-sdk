import { describe, it, expect } from "vitest";
import { planReconcile, classifyResumeError, classifyRecordDisposition } from "../src/core/reconcile.js";

describe("planReconcile", () => {
  it("corrupt store fails startup (never silently fresh)", () => {
    expect(planReconcile({ corrupt: true })).toEqual({ kind: "fail-corrupt" });
    // corrupt wins even if a state is somehow present
    expect(planReconcile({ corrupt: true, state: "active" }).kind).toBe("fail-corrupt");
  });

  it("no record → fresh", () => {
    expect(planReconcile({ corrupt: false })).toEqual({ kind: "fresh" });
  });

  it("creating (interrupted create) → orphan-interrupted (do NOT resume)", () => {
    expect(planReconcile({ corrupt: false, state: "creating" })).toEqual({ kind: "orphan-interrupted" });
  });

  it("orphaned / blocked → retain (no auto-clear)", () => {
    expect(planReconcile({ corrupt: false, state: "orphaned" })).toEqual({ kind: "retain" });
    expect(planReconcile({ corrupt: false, state: "blocked" })).toEqual({ kind: "retain" });
  });

  it("active + binding mismatch → block:config-mismatch (never resume wrong repo)", () => {
    expect(planReconcile({ corrupt: false, state: "active", bindingOk: false, threadStatus: "valid" })).toEqual({
      kind: "block",
      reason: "config-mismatch",
    });
  });

  it("active + binding ok + valid thread → resume", () => {
    expect(planReconcile({ corrupt: false, state: "active", bindingOk: true, threadStatus: "valid" })).toEqual({
      kind: "resume",
    });
  });

  it("active + definitive gone → block:thread-gone", () => {
    expect(planReconcile({ corrupt: false, state: "active", bindingOk: true, threadStatus: "gone" })).toEqual({
      kind: "block",
      reason: "thread-gone",
    });
  });

  it("active + inaccessible → block:thread-inaccessible", () => {
    expect(planReconcile({ corrupt: false, state: "active", bindingOk: true, threadStatus: "inaccessible" })).toEqual({
      kind: "block",
      reason: "thread-inaccessible",
    });
  });

  it("active + missing Discord access → retry without changing the record", () => {
    expect(planReconcile({ corrupt: false, state: "active", bindingOk: true, threadStatus: "no-access" })).toEqual({
      kind: "skip",
      reason: "thread-no-access",
    });
  });

  it("active + archived-unarchivable → block:thread-archived", () => {
    expect(
      planReconcile({ corrupt: false, state: "active", bindingOk: true, threadStatus: "archived-unarchivable" })
    ).toEqual({ kind: "block", reason: "thread-archived" });
  });

  it("active + TRANSIENT thread failure → skip (leave record unchanged, don't resume)", () => {
    const a = planReconcile({ corrupt: false, state: "active", bindingOk: true, threadStatus: "transient" });
    expect(a.kind).toBe("skip");
  });

  it("active with no thread status supplied → safe skip (never accidental resume)", () => {
    const a = planReconcile({ corrupt: false, state: "active", bindingOk: true });
    expect(a.kind).toBe("skip");
  });
});

describe("classifyResumeError", () => {
  it("network / DNS / timeout errors are TRANSIENT (never lose history)", () => {
    for (const m of [
      "getaddrinfo ENOTFOUND api.example.com",
      "no such host is known", // literal Windows DNS message — must NOT be 'session lost'
      "connect ECONNREFUSED 127.0.0.1:443",
      "socket hang up (ECONNRESET)",
      "request timed out",
      "fetch failed",
      "503 Service Unavailable",
      "connection refused",
    ]) {
      expect(classifyResumeError(m)).toBe("transient");
    }
  });

  it("definitive session-absent phrases are SESSION-LOST", () => {
    for (const m of [
      "session not found",
      "session does not exist",
      "session no longer exists",
      "unknown session id",
      "no such session",
      "session id abc invalid",
    ]) {
      expect(classifyResumeError(m)).toBe("session-lost");
    }
  });

  it("ambiguous/unknown errors default to TRANSIENT (retryable, non-destructive)", () => {
    expect(classifyResumeError("something went wrong")).toBe("transient");
    expect(classifyResumeError("")).toBe("transient");
    expect(classifyResumeError("internal error 500")).toBe("transient");
  });
});

// ---------------------------------------------------------------------------
// classifyRecordDisposition
// ---------------------------------------------------------------------------
describe("classifyRecordDisposition", () => {
  it("a record with a live session is never reapable", () => {
    for (const s of ["creating", "active", "orphaned", "blocked"] as const) {
      expect(classifyRecordDisposition(s, true, false)).toBe("live");
      expect(classifyRecordDisposition(s, true, true)).toBe("live");
    }
  });

  it("refuses to reap a `creating` record while a /new is in flight", () => {
    // cmdNew writes the record BEFORE the multi-second SessionActor.create(),
    // and only registers the live session after. Reaping in that window deletes
    // the worktree and record out from under /new, which then fails its commit
    // and blames the disk while deleting the operator's brand-new thread.
    expect(classifyRecordDisposition("creating", false, true)).toBe("in-flight");
  });

  it("treats a `creating` leftover as reapable once no /new is running", () => {
    expect(classifyRecordDisposition("creating", false, false)).toBe("reapable");
  });

  it("never reaps an `active` record with no live session — reconcile kept it on purpose", () => {
    // A transient resume failure deliberately leaves the record active so the
    // NEXT restart retries. Deleting it destroys the only pointer to a Copilot
    // conversation that would have come back.
    expect(classifyRecordDisposition("active", false, false)).toBe("retry-pending");
    expect(classifyRecordDisposition("active", false, true)).toBe("retry-pending");
  });

  it("reaps only the terminal states", () => {
    expect(classifyRecordDisposition("orphaned", false, false)).toBe("reapable");
    expect(classifyRecordDisposition("blocked", false, false)).toBe("reapable");
  });
});

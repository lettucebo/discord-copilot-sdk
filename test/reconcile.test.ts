import { describe, it, expect } from "vitest";
import { planReconcile } from "../src/core/reconcile.js";

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

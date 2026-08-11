import { describe, it, expect } from "vitest";
import { TurnRenderer } from "../src/core/turn-render.js";

describe("TurnRenderer", () => {
  it("streams deltas; a final message finalizes that message's text", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", text: "Hel" });
    r.apply({ type: "message_delta", text: "lo" });
    expect(r.state().assistantText).toBe("Hello");
    r.apply({ type: "message", content: "Hello, world." });
    expect(r.state().assistantText).toBe("Hello, world.");
  });

  it("streams a SECOND message in the same turn (post-tool) and keeps the first", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", text: "Looking…" });
    r.apply({ type: "message", content: "Looking into it." });
    r.apply({ type: "tool_start", id: "t1", name: "shell" });
    r.apply({ type: "tool_complete", id: "t1", status: "completed" });
    r.apply({ type: "message_delta", text: "The branch " });
    r.apply({ type: "message_delta", text: "is main." });
    expect(r.state().assistantText).toBe("Looking into it.\n\nThe branch is main.");
    r.apply({ type: "message", content: "The branch is main." });
    expect(r.state().assistantText).toBe("Looking into it.\n\nThe branch is main.");
  });

  it("treats root as agentId===undefined and ignores any sub-agent", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", text: "main " });
    r.apply({ type: "message_delta", agentId: "sub-1", text: "SUBAGENT " });
    r.apply({ type: "message_delta", text: "response" });
    expect(r.state().assistantText).toBe("main response");
  });

  it("does not let a sub-agent message overwrite the root response", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", text: "root answer" });
    r.apply({ type: "message", agentId: "sub-1", content: "SUBAGENT clobber" });
    r.apply({ type: "tool_start", agentId: "sub-1", id: "st", name: "search" });
    expect(r.state().assistantText).toBe("root answer");
    expect(r.state().tools).toHaveLength(0);
  });

  it("tracks tool calls in first-seen order with status updates", () => {
    const r = new TurnRenderer();
    r.apply({ type: "tool_start", id: "t1", name: "shell" });
    r.apply({ type: "tool_start", id: "t2", name: "read" });
    r.apply({ type: "tool_complete", id: "t1", status: "completed" });
    const tools = r.state().tools;
    expect(tools.map((t) => `${t.name}:${t.status}`)).toEqual(["shell:completed", "read:running"]);
  });

  it("keeps text, a tool, and post-tool text in arrival order", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", text: "I will inspect it." });
    r.apply({ type: "message", content: "I will inspect it." });
    r.apply({
      type: "tool_start",
      id: "t1",
      name: "read",
      possiblePaths: ["C:\\repo\\SKILL.md"],
    });
    r.apply({ type: "tool_complete", id: "t1", status: "completed" });
    r.apply({ type: "message_delta", text: "The file is present." });

    expect(r.state().items).toEqual([
      { kind: "text", text: "I will inspect it.", open: false },
      {
        kind: "tool",
        id: "t1",
        name: "read",
        possiblePaths: ["C:\\repo\\SKILL.md"],
        status: "completed",
      },
      { kind: "text", text: "The file is present.", open: true },
    ]);
  });

  it("does not create blank timeline items for tool-only empty messages", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message", content: "Before the tools." });
    for (const id of ["t1", "t2", "t3"]) {
      r.apply({ type: "tool_start", id, name: "read" });
      r.apply({ type: "message", content: "" });
      r.apply({ type: "tool_complete", id, status: "completed" });
    }
    r.apply({ type: "message", content: "After the tools." });

    expect(r.state().items.filter((item) => item.kind === "text")).toEqual([
      { kind: "text", text: "Before the tools.", open: false },
      { kind: "text", text: "After the tools.", open: false },
    ]);
    expect(r.state().assistantText).toBe("Before the tools.\n\nAfter the tools.");
  });

  it("keeps intent and finalized reasoning in chronological items", () => {
    const r = new TurnRenderer();
    r.apply({ type: "intent", text: "Inspecting the renderer" });
    r.apply({ type: "reasoning_delta", id: "r1", text: "Checking " });
    r.apply({ type: "reasoning", id: "r1", content: "Checking the event ordering." });

    expect(r.state().items).toEqual([
      { kind: "intent", text: "Inspecting the renderer" },
      { kind: "reasoning", id: "r1", text: "Checking the event ordering.", open: false },
    ]);
  });

  it("retains a failed tool's target and error for compact display", () => {
    const r = new TurnRenderer();
    r.apply({
      type: "tool_start",
      id: "t1",
      name: "shell",
      arguments: { command: "git status" },
      possiblePaths: ["C:\\repo"],
    });
    r.apply({ type: "tool_complete", id: "t1", status: "failed", error: "permission denied" });

    expect(r.state().items).toEqual([
      {
        kind: "tool",
        id: "t1",
        name: "shell",
        arguments: { command: "git status" },
        possiblePaths: ["C:\\repo"],
        status: "failed",
        error: "permission denied",
      },
    ]);
  });

  it("retains a failed tool error when completion arrives before its start event", () => {
    const r = new TurnRenderer();
    r.apply({
      type: "tool_complete",
      id: "t1",
      status: "failed",
      error: "permission denied",
    });

    expect(r.state().items).toEqual([
      {
        kind: "tool",
        id: "t1",
        name: "",
        status: "failed",
        error: "permission denied",
      },
    ]);
  });

  it("keeps exactly matching audit entries compact without merging different commands", () => {
    const r = new TurnRenderer();
    r.addAudit("shell: git status", "⚡ `shell`: `git status`");
    r.addAudit("shell: git status", "⚡ `shell`: `git status`");
    r.addAudit("shell: git diff", "⚡ `shell`: `git diff`");

    expect(r.state().items).toEqual([
      { kind: "audit", raw: "shell: git status", display: "⚡ `shell`: `git status`", count: 2 },
      { kind: "audit", raw: "shell: git diff", display: "⚡ `shell`: `git diff`", count: 1 },
    ]);
  });

  it("updates one todo item in place before the final answer", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message", content: "Final answer." });
    r.setTodos("- [x] First");
    r.setTodos("- [x] First\n- [ ] Second");

    expect(r.state().items).toEqual([
      { kind: "todos", text: "- [x] First\n- [ ] Second" },
      { kind: "text", text: "Final answer.", open: false },
    ]);
  });

  it("places late notices and audits before the terminal text item", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message", content: "Final answer." });
    r.addNotice("⚠️ Late session error");
    r.addAudit("read:a", "⚡ `read`: `a`");

    expect(r.state().items).toEqual([
      { kind: "notice", text: "⚠️ Late session error" },
      { kind: "audit", raw: "read:a", display: "⚡ `read`: `a`", count: 1 },
      { kind: "text", text: "Final answer.", open: false },
    ]);
  });
});

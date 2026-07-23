import { describe, it, expect } from "vitest";
import { TurnRenderer } from "../src/core/turn-render.js";

describe("TurnRenderer", () => {
  it("accumulates deltas until a final message supersedes them", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", text: "Hel" });
    r.apply({ type: "message_delta", text: "lo" });
    expect(r.state().assistantText).toBe("Hello");
    r.apply({ type: "message", content: "Hello, world." });
    expect(r.state().assistantText).toBe("Hello, world.");
    // late deltas after final are ignored
    r.apply({ type: "message_delta", text: "IGNORED" });
    expect(r.state().assistantText).toBe("Hello, world.");
  });

  it("ignores sub-agent (different agentId) output", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", agentId: "root", text: "main " });
    r.apply({ type: "message_delta", agentId: "sub-1", text: "SUBAGENT " });
    r.apply({ type: "message_delta", agentId: "root", text: "response" });
    expect(r.state().assistantText).toBe("main response");
  });

  it("treats an undefined root agentId consistently", () => {
    const r = new TurnRenderer();
    r.apply({ type: "message_delta", text: "a" }); // root = undefined
    r.apply({ type: "message_delta", agentId: "sub", text: "X" });
    r.apply({ type: "message_delta", text: "b" });
    expect(r.state().assistantText).toBe("ab");
  });

  it("tracks tool calls in first-seen order with status updates", () => {
    const r = new TurnRenderer();
    r.apply({ type: "tool_start", id: "t1", name: "shell" });
    r.apply({ type: "tool_start", id: "t2", name: "read" });
    r.apply({ type: "tool_complete", id: "t1", status: "completed" });
    const tools = r.state().tools;
    expect(tools.map((t) => `${t.name}:${t.status}`)).toEqual(["shell:completed", "read:running"]);
  });
});

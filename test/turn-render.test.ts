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
});

import { describe, it, expect } from "vitest";
import { normalizeSdkEvent } from "../src/copilot/normalize.js";
import { TurnRenderer } from "../src/core/turn-render.js";

// Envelopes shaped exactly like @github/copilot-sdk generated events:
// agentId is TOP-LEVEL; text/content/ids/success live under `data`.
const delta = (deltaContent: string, agentId?: string) => ({
  type: "assistant.message_delta",
  agentId,
  data: { deltaContent, messageId: "m1" },
});
const message = (content: string, agentId?: string) => ({
  type: "assistant.message",
  agentId,
  data: { content, role: "assistant" },
});
const toolStart = (toolCallId: string, toolName: string, agentId?: string) => ({
  type: "tool.execution_start",
  agentId,
  data: { toolCallId, toolName },
});
const toolDone = (toolCallId: string, success: boolean, agentId?: string) => ({
  type: "tool.execution_complete",
  agentId,
  data: { toolCallId, success },
});
const reasoningDelta = (reasoningId: string, deltaContent: string, agentId?: string) => ({
  type: "assistant.reasoning_delta",
  agentId,
  data: { reasoningId, deltaContent },
});
const reasoning = (reasoningId: string, content: string, agentId?: string) => ({
  type: "assistant.reasoning",
  agentId,
  data: { reasoningId, content },
});
const intent = (value: string, agentId?: string) => ({
  type: "assistant.intent",
  agentId,
  data: { intent: value },
});

describe("normalizeSdkEvent", () => {
  it("maps a streaming delta from data.deltaContent (not delta/text/content)", () => {
    expect(normalizeSdkEvent("assistant.message_delta", delta("Hel"))).toEqual({
      type: "message_delta",
      agentId: undefined,
      text: "Hel",
    });
  });

  it("reads agentId from the event top level, not data", () => {
    const n = normalizeSdkEvent("assistant.message", message("hi", "sub-7"));
    expect(n).toEqual({ type: "message", agentId: "sub-7", content: "hi" });
  });

  it("derives tool status from data.success (failed when false)", () => {
    expect(normalizeSdkEvent("tool.execution_complete", toolDone("t1", true))).toEqual({
      type: "tool_complete",
      agentId: undefined,
      id: "t1",
      status: "completed",
    });
    expect(normalizeSdkEvent("tool.execution_complete", toolDone("t1", false))).toEqual({
      type: "tool_complete",
      agentId: undefined,
      id: "t1",
      status: "failed",
    });
  });

  it("maps tool start ids/name from data.toolCallId + data.toolName", () => {
    expect(normalizeSdkEvent("tool.execution_start", toolStart("t9", "powershell"))).toEqual({
      type: "tool_start",
      agentId: undefined,
      id: "t9",
      name: "powershell",
      arguments: undefined,
      possiblePaths: [],
    });
  });

  it("preserves tool targets and a safe argument record for compact timeline display", () => {
    const event = {
      type: "tool.execution_start",
      data: {
        toolCallId: "t9",
        toolName: "shell",
        arguments: { command: "git status --short" },
        shellToolInfo: {
          hasWriteFileRedirection: false,
          possiblePaths: ["C:\\Source\\Repos\\example"],
        },
      },
    };
    expect(normalizeSdkEvent("tool.execution_start", event)).toEqual({
      type: "tool_start",
      agentId: undefined,
      id: "t9",
      name: "shell",
      arguments: { command: "git status --short" },
      possiblePaths: ["C:\\Source\\Repos\\example"],
    });
  });

  it("maps streamed and finalized reasoning from their documented data fields", () => {
    expect(normalizeSdkEvent("assistant.reasoning_delta", reasoningDelta("r1", "Checking "))).toEqual({
      type: "reasoning_delta",
      agentId: undefined,
      id: "r1",
      text: "Checking ",
    });
    expect(normalizeSdkEvent("assistant.reasoning", reasoning("r1", "Checking the files."))).toEqual({
      type: "reasoning",
      agentId: undefined,
      id: "r1",
      content: "Checking the files.",
    });
  });

  it("maps the short assistant intent for runtimes that omit raw reasoning", () => {
    expect(normalizeSdkEvent("assistant.intent", intent("Inspecting the renderer"))).toEqual({
      type: "intent",
      agentId: undefined,
      text: "Inspecting the renderer",
    });
  });

  it("preserves a failed tool's error message for compact failure display", () => {
    const event = {
      type: "tool.execution_complete",
      data: {
        toolCallId: "t1",
        success: false,
        error: { message: "permission denied" },
      },
    };
    expect(normalizeSdkEvent("tool.execution_complete", event)).toEqual({
      type: "tool_complete",
      agentId: undefined,
      id: "t1",
      status: "failed",
      error: "permission denied",
    });
  });

  it("ignores malformed non-string tool error messages", () => {
    const event = {
      type: "tool.execution_complete",
      data: {
        toolCallId: "t1",
        success: false,
        error: { message: { untrusted: "object" } },
      },
    };

    expect(normalizeSdkEvent("tool.execution_complete", event)).toEqual({
      type: "tool_complete",
      agentId: undefined,
      id: "t1",
      status: "failed",
    });
  });

  it("ignores unknown event types", () => {
    expect(normalizeSdkEvent("session.usage_info", { data: {} })).toBeUndefined();
  });
});

describe("normalizer + renderer: real streaming and sub-agent filtering", () => {
  it("streams deltas then lets the final message supersede them", () => {
    const r = new TurnRenderer();
    for (const raw of [delta("The current "), delta("branch is "), delta("`main`.")]) {
      r.apply(normalizeSdkEvent(raw.type, raw)!);
    }
    expect(r.state().assistantText).toBe("The current branch is `main`.");
    // Final persisted message replaces the streamed buffer.
    r.apply(normalizeSdkEvent("assistant.message", message("The current branch is `main`."))!);
    expect(r.state().assistantText).toBe("The current branch is `main`.");
  });

  it("filters sub-agent output so it can't overwrite the root response", () => {
    const r = new TurnRenderer();
    // Root binds to the first-seen agentId (undefined = root).
    r.apply(normalizeSdkEvent("assistant.message_delta", delta("root answer"))!);
    // A sub-agent (different agentId) must be ignored entirely.
    r.apply(normalizeSdkEvent("assistant.message", message("SUBAGENT clobber", "sub-1"))!);
    r.apply(normalizeSdkEvent("tool.execution_start", toolStart("st", "search", "sub-1"))!);
    expect(r.state().assistantText).toBe("root answer");
    expect(r.state().tools).toHaveLength(0);
  });

  it("tracks a root tool through start → complete", () => {
    const r = new TurnRenderer();
    r.apply(normalizeSdkEvent("tool.execution_start", toolStart("t1", "powershell"))!);
    r.apply(normalizeSdkEvent("tool.execution_complete", toolDone("t1", true))!);
    expect(r.state().tools).toEqual([{ id: "t1", name: "powershell", status: "completed" }]);
  });
});

import type { NormEvent } from "../core/turn-render.js";

/**
 * Map a raw Copilot SDK session event to the renderer's NormEvent, or undefined
 * for events we don't render.
 *
 * Field placements are pinned to @github/copilot-sdk's generated event types
 * (dist/generated/session-events.d.ts):
 *  - `agentId` is a TOP-LEVEL event field (absent ⇒ root/main agent), NOT under
 *    `data` — reading it from `data` defeats sub-agent filtering.
 *  - `assistant.message_delta` text is `data.deltaContent` (streaming chunk).
 *  - `assistant.message` final text is `data.content`.
 *  - reasoning carries `data.content` / `data.deltaContent` plus `reasoningId`;
 *    assistant.intent is a concise fallback when raw reasoning is unavailable.
 *  - tool events carry `data.toolCallId` + `data.toolName`, with target hints
 *    under `data.shellToolInfo.possiblePaths`; completion carries
 *    `data.success: boolean` (there is no `status` field).
 *
 * Pure and exported so a unit test can feed real event envelopes through it.
 */
export function normalizeSdkEvent(type: string, event: unknown): NormEvent | undefined {
  const ev = (event ?? {}) as { agentId?: unknown; data?: Record<string, unknown> };
  const agentId = typeof ev.agentId === "string" ? ev.agentId : undefined;
  const d = ev.data ?? {};
  switch (type) {
    case "assistant.message_delta":
      return { type: "message_delta", agentId, text: str(d["deltaContent"]) };
    case "assistant.message":
      return { type: "message", agentId, content: str(d["content"]) };
    case "assistant.reasoning_delta":
      return {
        type: "reasoning_delta",
        agentId,
        id: str(d["reasoningId"]),
        text: str(d["deltaContent"]),
      };
    case "assistant.reasoning":
      return {
        type: "reasoning",
        agentId,
        id: str(d["reasoningId"]),
        content: str(d["content"]),
      };
    case "assistant.intent":
      return { type: "intent", agentId, text: str(d["intent"]) };
    case "tool.execution_start":
      return {
        type: "tool_start",
        agentId,
        id: str(d["toolCallId"]),
        name: str(d["toolName"]),
        arguments: record(d["arguments"]),
        possiblePaths: possiblePaths(d["shellToolInfo"]),
        description: description(d["toolDescription"]),
      };
    case "tool.execution_complete": {
      const error = errorMessage(d["error"]);
      return {
        type: "tool_complete",
        agentId,
        id: str(d["toolCallId"]),
        status: d["success"] === false ? "failed" : "completed",
        ...(error ? { error } : {}),
      };
    }
    default:
      return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function possiblePaths(v: unknown): string[] {
  const paths = record(v)?.["possiblePaths"];
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

function description(v: unknown): string | undefined {
  const value = record(v)?.["description"];
  return typeof value === "string" ? value : undefined;
}

function errorMessage(v: unknown): string | undefined {
  const message = record(v)?.["message"];
  return typeof message === "string" ? message : undefined;
}

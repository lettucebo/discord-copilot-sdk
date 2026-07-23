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
 *  - tool events carry `data.toolCallId` + `data.toolName`; completion carries
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
    case "tool.execution_start":
      return {
        type: "tool_start",
        agentId,
        id: str(d["toolCallId"]),
        name: str(d["toolName"]),
      };
    case "tool.execution_complete":
      return {
        type: "tool_complete",
        agentId,
        id: str(d["toolCallId"]),
        status: d["success"] === false ? "failed" : "completed",
      };
    default:
      return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

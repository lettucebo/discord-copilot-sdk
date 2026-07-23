/** Normalized session events the renderer understands (mapped from the SDK). */
export type NormEvent =
  | { type: "message_delta"; agentId?: string; text: string }
  | { type: "message"; agentId?: string; content: string }
  | { type: "tool_start"; agentId?: string; id: string; name: string }
  | { type: "tool_complete"; agentId?: string; id: string; status: string };

export interface ToolView {
  id: string;
  name: string;
  status: string;
}

export interface RenderState {
  /** Authoritative text of the MAIN (root) assistant response for this turn. */
  assistantText: string;
  /** Tool calls of the main response, in first-seen order. */
  tools: ToolView[];
}

/**
 * Accumulates a single turn's events into a render state.
 *
 * Correctness rules (all flagged by review as easy to get wrong):
 *  - **Root vs sub-agent**: root/main-agent events have NO `agentId` (the SDK
 *    sets it only for sub-agents). We render root events and ignore sub-agents
 *    so the main response stays clean — binding to `agentId === undefined`, not
 *    "the first agent seen" (which a stray sub-agent event could hijack).
 *  - **Multi-message turns stream**: an agentic turn commonly emits an
 *    assistant message, runs a tool, then streams ANOTHER assistant message. We
 *    keep the finalized text of completed messages and a live buffer for the
 *    one currently streaming, so post-tool messages stream and earlier messages
 *    are not lost. A message's persisted `content` is authoritative for that
 *    message and replaces its streamed deltas.
 */
export class TurnRenderer {
  private finalizedText = "";
  private streamingBuf = "";
  private readonly toolOrder: string[] = [];
  private readonly tools = new Map<string, ToolView>();

  apply(e: NormEvent): void {
    if (e.agentId !== undefined) return; // ignore sub-agent noise
    switch (e.type) {
      case "message_delta":
        this.streamingBuf += e.text;
        return;
      case "message":
        // Authoritative content for the just-completed message: append it and
        // reset the live buffer for the next message in this turn.
        this.finalizedText += (this.finalizedText ? "\n\n" : "") + e.content;
        this.streamingBuf = "";
        return;
      case "tool_start":
        if (!this.tools.has(e.id)) this.toolOrder.push(e.id);
        this.tools.set(e.id, { id: e.id, name: e.name, status: "running" });
        return;
      case "tool_complete": {
        const prev = this.tools.get(e.id);
        if (prev) prev.status = e.status;
        else {
          this.toolOrder.push(e.id);
          this.tools.set(e.id, { id: e.id, name: "", status: e.status });
        }
        return;
      }
    }
  }

  state(): RenderState {
    const sep = this.finalizedText && this.streamingBuf ? "\n\n" : "";
    return {
      assistantText: this.finalizedText + sep + this.streamingBuf,
      tools: this.toolOrder.map((id) => this.tools.get(id)!),
    };
  }
}

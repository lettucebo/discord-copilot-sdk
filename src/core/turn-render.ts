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
 * Correctness rules (both flagged by review as easy to get wrong):
 *  - **Final message is authoritative**: once a persisted `message` arrives, its
 *    `content` replaces the streamed deltas — we never show both.
 *  - **Sub-agent filtering**: sub-agents stream with a different `agentId` and can
 *    interleave; we bind to the first-seen (root) agentId and ignore the rest, so
 *    the main response text stays clean.
 */
export class TurnRenderer {
  private rootAgentId: string | undefined;
  private rootBound = false;
  private deltaBuf = "";
  private finalText: string | undefined;
  private readonly toolOrder: string[] = [];
  private readonly tools = new Map<string, ToolView>();

  apply(e: NormEvent): void {
    if (!this.isRoot(e.agentId)) return; // ignore sub-agent noise
    switch (e.type) {
      case "message_delta":
        if (this.finalText === undefined) this.deltaBuf += e.text;
        return;
      case "message":
        this.finalText = e.content; // authoritative — supersedes deltas
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
    return {
      assistantText: this.finalText ?? this.deltaBuf,
      tools: this.toolOrder.map((id) => this.tools.get(id)!),
    };
  }

  /** Bind to the first agentId we see; thereafter only that agent is "root". */
  private isRoot(agentId: string | undefined): boolean {
    if (!this.rootBound) {
      this.rootAgentId = agentId;
      this.rootBound = true;
      return true;
    }
    return agentId === this.rootAgentId;
  }
}

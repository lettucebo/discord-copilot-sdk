/** Normalized session events the renderer understands (mapped from the SDK). */
export type NormEvent =
  | { type: "message_delta"; agentId?: string; text: string }
  | { type: "message"; agentId?: string; content: string }
  | { type: "reasoning_delta"; agentId?: string; id: string; text: string }
  | { type: "reasoning"; agentId?: string; id: string; content: string }
  | { type: "intent"; agentId?: string; text: string }
  | {
      type: "tool_start";
      agentId?: string;
      id: string;
      name: string;
      arguments?: Record<string, unknown>;
      possiblePaths?: string[];
      description?: string;
    }
  | { type: "tool_complete"; agentId?: string; id: string; status: string; error?: string };

export interface ToolView {
  id: string;
  name: string;
  status: string;
}

export type TimelineItem =
  | { kind: "text"; text: string; open: boolean }
  | { kind: "reasoning"; id: string; text: string; open: boolean }
  | { kind: "intent"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: string;
      arguments?: Record<string, unknown>;
      possiblePaths?: string[];
      description?: string;
      error?: string;
    }
  | { kind: "audit"; raw: string; display: string; count: number }
  | { kind: "notice"; text: string }
  | { kind: "todos"; text: string };

export type ToolCarry = Pick<
  Extract<TimelineItem, { kind: "tool" }>,
  "id" | "name" | "arguments" | "possiblePaths" | "description"
>;

export interface LegacyRenderState {
  /** Compatibility projection while DiscordTransport migrates to timeline formatting. */
  assistantText: string;
  /** Compatibility projection while DiscordTransport migrates to timeline formatting. */
  tools: ToolView[];
}

export interface TimelineRenderState extends LegacyRenderState {
  /** Ordered main-agent timeline, suitable for the Discord formatter. */
  items: TimelineItem[];
}

/** Accept legacy test fixtures until DiscordTransport consumes timeline items. */
export type RenderState = LegacyRenderState | TimelineRenderState;

/**
 * Accumulates root-agent session events into an ordered timeline.
 *
 * The SDK emits empty `assistant.message` events around tool-only work. Those
 * close a currently streaming text item but never create a timeline item; doing
 * otherwise turns every tool call into two visible blank lines in Discord.
 */
export class TurnRenderer {
  private readonly items: TimelineItem[] = [];
  private activeText: Extract<TimelineItem, { kind: "text" }> | undefined;
  private readonly reasoningById = new Map<string, Extract<TimelineItem, { kind: "reasoning" }>>();
  private readonly toolById = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  /** Tool metadata that was sealed above a Discord interaction card. */
  private readonly carriedTools = new Map<string, ToolCarry>();

  apply(e: NormEvent): void {
    if (e.agentId !== undefined) return; // root/main events have no agentId
    switch (e.type) {
      case "message_delta":
        if (!e.text) return;
        this.openText().text += e.text;
        return;
      case "message":
        this.applyMessage(e.content);
        return;
      case "reasoning_delta":
        this.applyReasoningDelta(e.id, e.text);
        return;
      case "reasoning":
        this.applyReasoning(e.id, e.content);
        return;
      case "intent":
        this.addIntent(e.text);
        return;
      case "tool_start":
        this.addTool(e);
        return;
      case "tool_complete":
        this.completeTool(e);
        return;
    }
  }

  addAudit(raw: string, display: string): void {
    this.closeText();
    if (!raw || !display) return;
    const index = this.statusInsertIndex();
    const previous = this.items[index - 1];
    if (previous?.kind === "audit" && previous.raw === raw) {
      previous.count += 1;
      return;
    }
    this.items.splice(index, 0, { kind: "audit", raw, display, count: 1 });
  }

  addNotice(text: string): void {
    this.closeText();
    if (text.trim()) this.items.splice(this.statusInsertIndex(), 0, { kind: "notice", text });
  }

  /**
   * Todos are a status projection, not a later assistant utterance. Keep one
   * updatable item ahead of the final text so a late refresh cannot move the
   * answer away from the bottom of the rendered turn.
   */
  setTodos(text: string): void {
    this.closeText();
    const existing = this.items.find((item): item is Extract<TimelineItem, { kind: "todos" }> => item.kind === "todos");
    if (existing) {
      existing.text = text;
      return;
    }
    if (!text.trim()) return;
    const lastText = this.findLastText();
    if (lastText) {
      this.items.splice(this.items.indexOf(lastText), 0, { kind: "todos", text });
    } else {
      this.items.push({ kind: "todos", text });
    }
  }

  /** Remove the status projection when the SDK's todo table becomes empty. */
  clearTodos(): void {
    const index = this.items.findIndex((item) => item.kind === "todos");
    if (index >= 0) this.items.splice(index, 1);
  }

  /** Snapshot running tools before a card starts a new render block. */
  inFlightTools(): ToolCarry[] {
    return this.items
      .filter(
        (item): item is Extract<TimelineItem, { kind: "tool" }> =>
          item.kind === "tool" && item.status === "running"
      )
      .map(({ id, name, arguments: args, possiblePaths, description }) => ({
        id,
        name,
        ...(args ? { arguments: { ...args } } : {}),
        ...(possiblePaths ? { possiblePaths: [...possiblePaths] } : {}),
        ...(description ? { description } : {}),
      }));
  }

  /** Carry tool identity across a card so completion is never rendered unnamed. */
  adoptTools(tools: readonly ToolCarry[]): void {
    for (const tool of tools) {
      this.carriedTools.set(tool.id, {
        ...tool,
        ...(tool.arguments ? { arguments: { ...tool.arguments } } : {}),
        ...(tool.possiblePaths ? { possiblePaths: [...tool.possiblePaths] } : {}),
      });
    }
  }

  state(): TimelineRenderState {
    const items = this.items.map(copyItem);
    const text = items.filter((item): item is Extract<TimelineItem, { kind: "text" }> => item.kind === "text");
    const tools = items
      .filter((item): item is Extract<TimelineItem, { kind: "tool" }> => item.kind === "tool")
      .map(({ id, name, status }) => ({ id, name, status }));
    return {
      items,
      assistantText: text.map((item) => item.text).join("\n\n"),
      tools,
    };
  }

  private applyMessage(content: string): void {
    const value = content.trim() ? content : "";
    if (this.activeText) {
      if (value) {
        this.activeText.text = value; // final SDK event is authoritative
      } else if (!this.activeText.text.trim()) {
        this.items.splice(this.items.indexOf(this.activeText), 1);
      }
      this.closeText();
      return;
    }
    if (value) this.items.push({ kind: "text", text: value, open: false });
  }

  private applyReasoningDelta(id: string, text: string): void {
    this.closeText();
    if (!text) return;
    let item = this.reasoningById.get(id);
    if (!item) {
      item = { kind: "reasoning", id, text: "", open: true };
      this.reasoningById.set(id, item);
      this.items.push(item);
    }
    item.text += text;
  }

  private applyReasoning(id: string, content: string): void {
    this.closeText();
    let item = this.reasoningById.get(id);
    if (!item) {
      if (!content.trim()) return;
      item = { kind: "reasoning", id, text: content, open: false };
      this.reasoningById.set(id, item);
      this.items.push(item);
      return;
    }
    if (content.trim()) item.text = content; // final SDK event is authoritative
    else if (!item.text.trim()) this.items.splice(this.items.indexOf(item), 1);
    item.open = false;
  }

  private addIntent(text: string): void {
    this.closeText();
    if (text.trim()) this.items.push({ kind: "intent", text });
  }

  private addTool(e: Extract<NormEvent, { type: "tool_start" }>): void {
    this.closeText();
    const existing = this.toolById.get(e.id);
    if (existing) {
      existing.name = e.name || existing.name;
      if (e.arguments) existing.arguments = e.arguments;
      if (e.possiblePaths?.length) existing.possiblePaths = [...e.possiblePaths];
      if (e.description) existing.description = e.description;
      this.rememberTool(existing);
      return;
    }
    const item: Extract<TimelineItem, { kind: "tool" }> = {
      kind: "tool",
      id: e.id,
      name: e.name,
      status: "running",
      ...(e.arguments ? { arguments: e.arguments } : {}),
      ...(e.possiblePaths?.length ? { possiblePaths: [...e.possiblePaths] } : {}),
      ...(e.description ? { description: e.description } : {}),
    };
    this.toolById.set(e.id, item);
    this.rememberTool(item);
    this.items.push(item);
  }

  private completeTool(e: Extract<NormEvent, { type: "tool_complete" }>): void {
    this.closeText();
    let item = this.toolById.get(e.id);
    if (!item) {
      const carried = this.carriedTools.get(e.id);
      item = {
        kind: "tool",
        id: e.id,
        name: carried?.name ?? "",
        status: e.status,
        ...(carried?.arguments ? { arguments: { ...carried.arguments } } : {}),
        ...(carried?.possiblePaths ? { possiblePaths: [...carried.possiblePaths] } : {}),
        ...(carried?.description ? { description: carried.description } : {}),
      };
      this.toolById.set(e.id, item);
      this.items.push(item);
    } else {
      item.status = e.status;
    }
    this.carriedTools.delete(e.id);
    if (e.error) item.error = e.error;
  }

  private rememberTool(item: Extract<TimelineItem, { kind: "tool" }>): void {
    this.carriedTools.set(item.id, {
      id: item.id,
      name: item.name,
      ...(item.arguments ? { arguments: { ...item.arguments } } : {}),
      ...(item.possiblePaths ? { possiblePaths: [...item.possiblePaths] } : {}),
      ...(item.description ? { description: item.description } : {}),
    });
  }

  private openText(): Extract<TimelineItem, { kind: "text" }> {
    if (!this.activeText) {
      this.activeText = { kind: "text", text: "", open: true };
      this.items.push(this.activeText);
    }
    return this.activeText;
  }

  private closeText(): void {
    if (!this.activeText) return;
    this.activeText.open = false;
    this.activeText = undefined;
  }

  private findLastText(): Extract<TimelineItem, { kind: "text" }> | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item?.kind === "text") return item;
    }
    return undefined;
  }

  private statusInsertIndex(): number {
    const terminal = this.findLastText();
    return terminal ? this.items.indexOf(terminal) : this.items.length;
  }
}

function copyItem(item: TimelineItem): TimelineItem {
  switch (item.kind) {
    case "tool":
      return {
        ...item,
        ...(item.arguments ? { arguments: { ...item.arguments } } : {}),
        ...(item.possiblePaths ? { possiblePaths: [...item.possiblePaths] } : {}),
      };
    default:
      return { ...item };
  }
}

import {
  type Client,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { chunkText } from "../../core/chunk.js";
import type { RenderState } from "../../core/turn-render.js";
import type { Decision, PermissionView, PlanView, Transport, UserInputView } from "../../core/transport.js";
import { encodePermissionId, encodeChoiceId, encodePlanId } from "./custom-id.js";
import { sanitizeForCodeBlock } from "../../core/text-safety.js";

export { sanitizeForCodeBlock };

/** Never let agent-produced text ping anyone. */
const NO_MENTIONS = { allowedMentions: { parse: [] as never[] } };
const RENDER_INTERVAL_MS = 1000;

interface SessionRender {
  msgIds: string[];
  latest?: RenderState;
  timer?: ReturnType<typeof setTimeout>;
  /** Turn counter; a render write for a stale epoch is dropped. */
  epoch: number;
  /** Per-session write mutex so timer-flush and final-flush never interleave. */
  writeChain: Promise<void>;
}

interface MinimalMessage {
  id: string;
  edit(opts: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
}

interface MinimalTextChannel {
  isTextBased(): boolean;
  send(opts: unknown): Promise<MinimalMessage>;
  messages: { fetch(id: string): Promise<MinimalMessage> };
}

/** Transport that posts to Discord threads. Renders are debounced (~1s) and
 *  serialized per session; the final state is always flushed. */
export class DiscordTransport implements Transport {
  private readonly sessions = new Map<string, SessionRender>();
  /** One handler per live SessionActor; a decision is broadcast to all and only
   *  the broker owning the nonce settles (others no-op). */
  private readonly decisionHandlers = new Set<
    (nonce: string, decision: Decision, userId: string) => void
  >();
  private readonly choiceHandlers = new Set<(nonce: string, index: number, userId: string) => void>();
  private readonly planHandlers = new Set<
    (nonce: string, action: number | "reject", userId: string) => void
  >();

  constructor(private readonly client: Client) {}

  onDecision(handler: (nonce: string, decision: Decision, userId: string) => void): () => void {
    this.decisionHandlers.add(handler);
    return () => this.decisionHandlers.delete(handler);
  }

  onChoice(handler: (nonce: string, index: number, userId: string) => void): () => void {
    this.choiceHandlers.add(handler);
    return () => this.choiceHandlers.delete(handler);
  }

  onPlan(handler: (nonce: string, action: number | "reject", userId: string) => void): () => void {
    this.planHandlers.add(handler);
    return () => this.planHandlers.delete(handler);
  }

  /** Called by the app's interaction router after auth passes. */
  deliverDecision(nonce: string, decision: Decision, userId: string): void {
    for (const h of this.decisionHandlers) h(nonce, decision, userId);
  }

  deliverChoice(nonce: string, index: number, userId: string): void {
    for (const h of this.choiceHandlers) h(nonce, index, userId);
  }

  deliverPlan(nonce: string, action: number | "reject", userId: string): void {
    for (const h of this.planHandlers) h(nonce, action, userId);
  }

  private ensure(sessionKey: string): SessionRender {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      s = { msgIds: [], epoch: 0, writeChain: Promise.resolve() };
      this.sessions.set(sessionKey, s);
    }
    return s;
  }

  /** Start a fresh turn: bump the epoch, drop old anchors + pending timer so a
   *  leftover render can't repost the previous turn or clobber the new one. */
  resetTurn(sessionKey: string): void {
    const s = this.ensure(sessionKey);
    s.epoch += 1;
    s.msgIds = [];
    s.latest = undefined;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
    }
  }

  async render(sessionKey: string, state: RenderState): Promise<void> {
    const s = this.ensure(sessionKey);
    s.latest = state;
    if (s.timer) return; // a flush is already scheduled
    s.timer = setTimeout(() => {
      const cur = this.sessions.get(sessionKey);
      if (cur) cur.timer = undefined;
      void this.flush(sessionKey);
    }, RENDER_INTERVAL_MS);
  }

  /** Force-write the latest state now (serialized, epoch-fenced). */
  async flush(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
    }
    const epoch = s.epoch;
    const run = s.writeChain.then(() => this.doFlush(sessionKey, epoch));
    s.writeChain = run.catch(() => {});
    await run.catch(() => {});
  }

  private async doFlush(sessionKey: string, epoch: number): Promise<void> {
    const s = this.sessions.get(sessionKey);
    if (!s || s.epoch !== epoch || !s.latest) return; // stale turn or disposed
    const text = formatState(s.latest);
    const chunks = text.length ? chunkText(text, 1900) : [];
    const channel = await this.fetchThread(sessionKey);
    if (!channel) return;
    for (let i = 0; i < chunks.length; i++) {
      if (s.epoch !== epoch) return; // a new turn started mid-write
      const content = chunks[i]!;
      const existing = s.msgIds[i];
      if (existing) {
        try {
          const m = await channel.messages.fetch(existing);
          await m.edit({ content, ...NO_MENTIONS });
        } catch {
          /* message deleted/unreachable — best effort */
        }
      } else {
        const m = await channel.send({ content, ...NO_MENTIONS });
        // A resetTurn/dispose may have landed while the send was in flight; if
        // so this message belongs to a turn that no longer exists — delete it
        // instead of recording its id into the new epoch's state.
        if (s.epoch !== epoch) {
          try {
            await m.delete();
          } catch {
            /* best effort */
          }
          return;
        }
        s.msgIds[i] = m.id;
      }
    }
    // Trim anchors the shorter final output no longer needs.
    for (let i = chunks.length; i < s.msgIds.length; i++) {
      const id = s.msgIds[i];
      if (!id) continue;
      try {
        const m = await channel.messages.fetch(id);
        await m.delete();
      } catch {
        /* already gone */
      }
    }
    if (s.msgIds.length > chunks.length) s.msgIds.length = chunks.length;
  }

  async showPermission(view: PermissionView): Promise<void> {
    const channel = await this.fetchThread(view.sessionKey);
    if (!channel) return;
    const bypass = view.summary.includes("SANDBOX BYPASS");
    const embed = new EmbedBuilder()
      .setColor(bypass ? 0xe74c3c : 0xf1c40f)
      .setTitle(`🔐 Permission requested: ${view.kind}${bypass ? " ⚠️ SANDBOX BYPASS" : ""}`)
      .setDescription("```\n" + sanitizeForCodeBlock(view.summary) + "\n```");
    if (view.canOfferSession && view.scopeCommands.length) {
      // Informed consent: session/always don't just approve THIS command — they
      // auto-approve every future invocation of these executables with no
      // further prompt, INCLUDING anything those executables can launch via
      // their own options (e.g. git pagers/diff/ssh commands).
      const list = view.scopeCommands.map((c) => `\`${c}\``).join(", ");
      embed.addFields({
        name: "⚠️ Session / Always scope",
        value:
          `Auto-approves ALL future ${list} commands with no further Discord prompt ` +
          `(for the session / this repo). This also trusts anything ${list} can run ` +
          `via its own options — approve only executables you fully trust.`,
      });
    }
    embed.setFooter({
      text: view.canOfferSession
        ? "Once = this request · Session = until the session ends · Always = remembered for this repo"
        : "Approve applies to this single request only.",
    });
    const row = new ActionRowBuilder<ButtonBuilder>();
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(encodePermissionId(view.nonce, "once"))
        .setLabel("Allow once")
        .setStyle(ButtonStyle.Success)
    );
    if (view.canOfferSession) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(encodePermissionId(view.nonce, "session"))
          .setLabel("Allow for session")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(encodePermissionId(view.nonce, "always"))
          .setLabel("Always (this repo)")
          .setStyle(ButtonStyle.Secondary)
      );
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(encodePermissionId(view.nonce, "deny"))
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
    );
    await channel.send({ embeds: [embed], components: [row], ...NO_MENTIONS });
  }

  async notice(sessionKey: string, text: string): Promise<void> {
    const channel = await this.fetchThread(sessionKey);
    if (channel) await channel.send({ content: text.slice(0, 1900), ...NO_MENTIONS });
  }

  async showUserInput(view: UserInputView): Promise<void> {
    const channel = await this.fetchThread(view.sessionKey);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("❓ Copilot is asking")
      .setDescription(view.question.slice(0, 4000))
      .setFooter({
        text: view.allowFreeform
          ? "Pick an option below, or type your answer in this thread."
          : "Pick an option below.",
      });
    const rows = buttonRows(
      view.choices.slice(0, 25).map((choice, i) =>
        new ButtonBuilder()
          .setCustomId(encodeChoiceId(view.nonce, i))
          .setLabel(truncateLabel(choice))
          .setStyle(ButtonStyle.Secondary)
      )
    );
    await channel.send({ embeds: [embed], components: rows, ...NO_MENTIONS });
  }

  async showPlan(view: PlanView): Promise<void> {
    const channel = await this.fetchThread(view.sessionKey);
    if (!channel) return;
    let desc = view.summary.slice(0, 3500);
    if (view.planContent) {
      const body = sanitizeForCodeBlock(view.planContent).slice(0, 3500 - desc.length);
      if (body) desc += "\n\n```\n" + body + "\n```";
    }
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle("📋 Plan ready — approve to proceed")
      .setDescription(desc || "(no summary)")
      .setFooter({ text: "Choose an action, or Reject to send it back with feedback." });
    const buttons = view.actions.slice(0, 24).map((action, i) =>
      new ButtonBuilder()
        .setCustomId(encodePlanId(view.nonce, i))
        .setLabel(truncateLabel(action))
        .setStyle(action === view.recommendedAction ? ButtonStyle.Success : ButtonStyle.Primary)
    );
    buttons.push(
      new ButtonBuilder()
        .setCustomId(encodePlanId(view.nonce, "reject"))
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger)
    );
    await channel.send({ embeds: [embed], components: buttonRows(buttons), ...NO_MENTIONS });
  }

  /** Release a session's render state + any pending timer. */
  dispose(sessionKey: string): void {
    const s = this.sessions.get(sessionKey);
    if (s?.timer) clearTimeout(s.timer);
    this.sessions.delete(sessionKey);
  }

  private async fetchThread(id: string): Promise<MinimalTextChannel | undefined> {
    try {
      const ch = await this.client.channels.fetch(id);
      return ch && (ch as unknown as MinimalTextChannel).isTextBased()
        ? (ch as unknown as MinimalTextChannel)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Split buttons into Discord action rows (max 5 per row, max 5 rows). */
function buttonRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

/** Discord button labels are capped at 80 chars. */
function truncateLabel(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 80 ? t || "(option)" : t.slice(0, 77) + "…";
}

function formatState(state: RenderState): string {
  const toolLine = state.tools.length
    ? "\n" + state.tools.map((t) => `🔧 ${t.name || "tool"} — ${t.status}`).join("\n")
    : "";
  return (state.assistantText || "") + toolLine;
}

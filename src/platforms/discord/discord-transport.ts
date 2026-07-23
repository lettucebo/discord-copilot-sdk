import {
  type Client,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { chunkText } from "../../core/chunk.js";
import type { RenderState } from "../../core/turn-render.js";
import type { Decision, PermissionView, Transport } from "../../core/transport.js";
import { encodePermissionId } from "./custom-id.js";

/** Never let agent-produced text ping anyone. */
const NO_MENTIONS = { allowedMentions: { parse: [] as never[] } };
const RENDER_INTERVAL_MS = 1000;

interface SessionRender {
  msgIds: string[];
  latest?: RenderState;
  timer?: ReturnType<typeof setTimeout>;
}

interface MinimalTextChannel {
  isTextBased(): boolean;
  send(opts: unknown): Promise<{ id: string }>;
  messages: { fetch(id: string): Promise<{ edit(opts: unknown): Promise<unknown> }> };
}

/** Transport that posts to Discord threads. Debounces render edits (~1s) to
 *  respect rate limits; the final state is always flushed. */
export class DiscordTransport implements Transport {
  private readonly sessions = new Map<string, SessionRender>();
  /** One handler per live SessionActor. A decision is broadcast to all; only the
   *  broker that owns the nonce settles (others no-op), so concurrent threads
   *  route correctly without the actors sharing state. */
  private readonly decisionHandlers = new Set<
    (nonce: string, decision: Decision, userId: string) => void
  >();

  constructor(private readonly client: Client) {}

  onDecision(handler: (nonce: string, decision: Decision, userId: string) => void): void {
    this.decisionHandlers.add(handler);
  }

  /** Called by the app's interaction router after auth passes. */
  deliverDecision(nonce: string, decision: Decision, userId: string): void {
    for (const h of this.decisionHandlers) h(nonce, decision, userId);
  }

  /** Start a fresh turn's message set for a session. */
  resetTurn(sessionKey: string): void {
    const s = this.sessions.get(sessionKey);
    if (s) s.msgIds = [];
  }

  async render(sessionKey: string, state: RenderState): Promise<void> {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      s = { msgIds: [] };
      this.sessions.set(sessionKey, s);
    }
    s.latest = state;
    if (s.timer) return; // a flush is already scheduled
    s.timer = setTimeout(() => {
      const cur = this.sessions.get(sessionKey);
      if (cur) cur.timer = undefined;
      void this.flush(sessionKey);
    }, RENDER_INTERVAL_MS);
  }

  /** Force-write the latest state now (e.g. at turn idle). */
  async flush(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey);
    if (!s || !s.latest) return;
    const text = formatState(s.latest);
    const chunks = text.length ? chunkText(text, 1900) : [];
    const channel = await this.fetchThread(sessionKey);
    if (!channel) return;
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i]!;
      const existing = s.msgIds[i];
      if (existing) {
        try {
          const m = await channel.messages.fetch(existing);
          await m.edit({ content, ...NO_MENTIONS });
        } catch {
          /* message deleted — best effort */
        }
      } else {
        const m = await channel.send({ content, ...NO_MENTIONS });
        s.msgIds[i] = m.id;
      }
    }
  }

  async showPermission(view: PermissionView): Promise<void> {
    const channel = await this.fetchThread(view.sessionKey);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`🔐 Permission requested: ${view.kind}`)
      .setDescription("```\n" + view.summary.slice(0, 3900) + "\n```")
      .setFooter({ text: "Approve applies to this single request only." });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodePermissionId(view.nonce, "allow"))
        .setLabel("Allow once")
        .setStyle(ButtonStyle.Success),
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

function formatState(state: RenderState): string {
  const toolLine = state.tools.length
    ? "\n" + state.tools.map((t) => `🔧 ${t.name || "tool"} — ${t.status}`).join("\n")
    : "";
  return (state.assistantText || "") + toolLine;
}

import {
  type Client,
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";
import { chunkText } from "../../core/chunk.js";
import type { RenderState } from "../../core/turn-render.js";
import { formatTimelineItems } from "../../core/format-timeline.js";
import { chunkTimeline } from "../../core/timeline-chunk.js";
import type {
  Decision,
  PermissionView,
  PlanView,
  SendFileOptions,
  SendFileResult,
  Transport,
  UserInputView,
} from "../../core/transport.js";
import { encodePermissionId, encodeChoiceId, encodePlanId } from "./custom-id.js";
import { renderChunks } from "./render-chunks.js";
import { sanitizeForCodeBlock } from "../../core/text-safety.js";
import type { OutboundFile } from "../../core/outbound-file.js";

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
  permissionsFor?(member: unknown): { has(flag: bigint): boolean } | null;
}

interface DiscordLikeError {
  code?: number;
  message?: string;
}

/** Transport that posts to Discord threads. Renders are debounced (~1s) and
 *  serialized per session; the final state is always flushed. */
export class DiscordTransport implements Transport {
  private readonly sessions = new Map<string, SessionRender>();
  private readonly attachNoticeSessions = new Set<string>();
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
    const chunks =
      "items" in s.latest
        ? chunkTimeline(formatTimelineItems(s.latest.items), 1900)
        : legacyChunks(s.latest);
    const channel = await this.fetchThread(sessionKey);
    if (!channel) return;
    // Liveness for the whole write, not just this instant. `dispose()` only
    // deletes the map entry and never mutates `s`, so an epoch-only predicate
    // cannot see a teardown — and every actual send/edit happens inside
    // renderChunks, AFTER further awaits. Checking identity here as well is what
    // makes render-chunks' "a message whose turn no longer exists gets deleted,
    // not recorded" rule apply to dispose and not only to a new turn.
    const stillCurrent = (): boolean => this.sessions.get(sessionKey) === s && s.epoch === epoch;
    if (!stillCurrent()) return;
    await renderChunks(channel, s.msgIds, chunks, stillCurrent, (content) => ({ content, ...NO_MENTIONS }));
  }

  async showPermission(view: PermissionView): Promise<void> {
    const channel = await this.fetchThread(view.sessionKey);
    // Never report false success: fetchThread swallows every failure (rate
    // limit, 5xx, deleted thread). Returning normally would leave the actor's
    // broker entry pending for the full permission timeout with no card and no
    // notice; throwing lets it settle deny immediately. Same contract as
    // showUserInput/showPlan below.
    if (!channel) throw new Error("permission thread unavailable");
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

  async sendFile(
    sessionKey: string,
    file: OutboundFile,
    note?: string,
    options?: SendFileOptions
  ): Promise<SendFileResult> {
    if (!canSendFile(options)) return { ok: false, reason: "cancelled" };
    const channel = await this.fetchThread(sessionKey);
    if (!canSendFile(options)) return { ok: false, reason: "cancelled" };
    if (!channel) return { ok: false, reason: "unavailable" };

    const permission = this.getAttachPermission(channel);
    if (permission === false) {
      await this.postMissingAttachNoticeOnce(sessionKey, channel);
      return { ok: false, reason: "no-attach-permission" };
    }

    try {
      const content = typeof note === "string" ? note.slice(0, 1900) : undefined;
      const payload = {
        ...(content ? { content } : {}),
        files: [new AttachmentBuilder(file.bytes, { name: file.displayName })],
        ...NO_MENTIONS,
      };
      if (!canSendFile(options)) return { ok: false, reason: "cancelled" };
      const message = await channel.send(payload);
      if (!canSendFile(options)) {
        // A turn can end while Discord accepts the attachment. Start deletion
        // without making cleanup availability decide whether the caller learns
        // the delivery was cancelled.
        void message.delete().catch(() => {});
        return { ok: false, reason: "cancelled" };
      }
      return { ok: true };
    } catch (error: unknown) {
      return this.classifySendFileError(error);
    }
  }

  async notice(sessionKey: string, text: string): Promise<void> {
    const channel = await this.fetchThread(sessionKey);
    if (channel) await channel.send({ content: text.slice(0, 1900), ...NO_MENTIONS });
  }

  async noticeDelivered(sessionKey: string, text: string): Promise<boolean> {
    const channel = await this.fetchThread(sessionKey);
    if (!channel) return false;
    try {
      await channel.send({ content: text.slice(0, 1900), ...NO_MENTIONS });
      return true;
    } catch {
      // A channel we can fetch but not post in (missing Send Messages) is just
      // as undelivered as one that is gone — the caller needs to try elsewhere.
      return false;
    }
  }

  async showUserInput(view: UserInputView): Promise<void> {
    const channel = await this.fetchThread(view.sessionKey);
    if (!channel) throw new Error("ask_user thread unavailable"); // never report false success
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
    if (!channel) throw new Error("plan thread unavailable"); // actor settles "not approved"
    // Publish the COMPLETE plan text (summary + full content) first, chunked, so
    // approval is informed — never truncate the info the operator decides on.
    const full = view.summary + (view.planContent ? "\n\n" + view.planContent : "");
    const chunks = chunkText("📋 Proposed plan:\n" + full);
    if (chunks.length > 20) throw new Error("plan too long to publish in full");
    for (const c of chunks) await channel.send({ content: c, ...NO_MENTIONS });
    // Compact approval card that references the full plan posted above.
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle("📋 Plan ready — approve to proceed")
      .setDescription("Review the plan above, then choose an action (or Reject with feedback).");
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

  private getAttachPermission(channel: MinimalTextChannel): boolean | "unknown" {
    if (typeof channel.permissionsFor !== "function") return "unknown";
    const member = this.client.user ?? this.client;
    const permissions = channel.permissionsFor(member);
    if (permissions === undefined) return "unknown";
    if (permissions === null) return false;
    return permissions.has(PermissionFlagsBits.AttachFiles);
  }

  private async postMissingAttachNoticeOnce(sessionKey: string, channel: MinimalTextChannel): Promise<void> {
    if (this.attachNoticeSessions.has(sessionKey)) return;
    this.attachNoticeSessions.add(sessionKey);
    try {
      await channel.send({
        content:
          "目前這個執行個體缺少 Discord「Attach Files」權限，無法傳送檔案。請用正確的邀請整數 326417632256 重新邀請機器人，並確認目標討論串/頻道允許 Attach Files。",
        ...NO_MENTIONS,
      });
    } catch {
      // Best effort only: the classified result still tells the caller upload is blocked by permissions.
    }
  }

  private classifySendFileError(error: unknown): SendFileResult {
    if (!isDiscordLikeError(error)) return { ok: false, reason: "transient" };
    if (error.code === 50013) return { ok: false, reason: "no-attach-permission" };
    if (error.code === 40005 || error.code === 50045) return { ok: false, reason: "too-large" };
    if (isPlatformBlockedUploadError(error)) return { ok: false, reason: "blocked" };
    return { ok: false, reason: "transient" };
  }
}

function isDiscordLikeError(error: unknown): error is DiscordLikeError {
  return typeof error === "object" && error !== null;
}

/** Treat a throwing lifecycle predicate as stale rather than risking an upload. */
function canSendFile(options: SendFileOptions | undefined): boolean {
  try {
    return options?.canSend?.() ?? true;
  } catch {
    return false;
  }
}

function isPlatformBlockedUploadError(error: DiscordLikeError): boolean {
  const msg = typeof error.message === "string" ? error.message.toLowerCase() : "";
  const hasUploadContext =
    msg.includes("upload") ||
    msg.includes("send this file") ||
    (msg.includes("send") && msg.includes("file"));
  const hasRestrictionSignal =
    msg.includes("blocked") ||
    msg.includes("flagged") ||
    msg.includes("restriction") ||
    msg.includes("restricted");
  return hasUploadContext && hasRestrictionSignal;
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

function legacyChunks(state: RenderState): string[] {
  const text = formatState(state);
  return text.length ? chunkText(text, 1900) : [];
}

function formatState(state: RenderState): string {
  const toolLine = state.tools.length
    ? "\n" + state.tools.map((t) => `🔧 ${t.name || "tool"} — ${t.status}`).join("\n")
    : "";
  return (state.assistantText || "") + toolLine;
}

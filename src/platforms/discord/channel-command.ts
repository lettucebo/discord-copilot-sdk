/**
 * `/channel enable | disable | list` — which channels this bot answers in.
 *
 * Extracted from `app.ts` so the security boundary it implements is readable in
 * one file: this is the ONE command gated on `isOwner` rather than
 * `isAuthorized`, because it must work in a channel that is not enabled yet, or
 * no channel could ever be added. Nothing else may follow it — a button or
 * autocomplete accepted on owner alone would let a click from an unrelated
 * channel drive a session.
 *
 * On the ready path this module is the primary owner gate. Pre-ready dispatch
 * also checks the same location-independent gate before admission, but this
 * check must remain here so every entry point — including a future direct call
 * — is refused rather than silently granted a registry write.
 *
 * The module deliberately receives an explicit capability object rather than
 * the app: it may read the registry, the live session map, the durable records
 * and Discord's channel view, and nothing else.
 */
import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { ChannelRegistry, CONFIG_SEED_ADDED_BY } from "../../core/channel-registry.js";
import type { OwnedScope } from "../../core/lifecycle-ownership.js";
import type { SessionRecord } from "../../core/session-store.js";
import { isOwner, type AuthContext, type AuthPolicy } from "./auth.js";
import { botCanViewChannel, fetchChannelSafe, isObfuscatedChannel } from "./channel-fetch.js";
import { NO_MENTIONS } from "./discord-transport.js";

/** The Discord capabilities this cluster needs: fetch one channel, and read the
 *  client's channel cache for the visibility drift report. Structural so no
 *  caller has to hand over more of the client than that. */
export interface ChannelCommandClient {
  channels: {
    fetch(id: string, options?: { force?: boolean }): Promise<unknown>;
    cache: { values(): Iterable<unknown> };
  };
}

/** The live sessions as this module needs to see them: which parent channel
 *  each thread's session hangs under. Structural on purpose — importing the
 *  app's `Session` would drag the whole runtime into a Discord command. */
export type LiveSessionView = ReadonlyMap<string, { readonly parentChannelId: string }>;

/** Verdict on an enable target: a refusal, or the working permissions the bot
 *  is missing there (advisory only — see `inspectChannelTarget`). */
export interface ChannelTargetInspection {
  error?: string;
  missing: string[];
}

/** What `inspectChannelTarget` may look at. */
export interface ChannelTargetContext {
  discord: ChannelCommandClient;
  /** The configured guild. A target outside it is refused, never enabled. */
  guildId: string;
  /** Read per call, not captured: `Attach Files` is only diagnosed where file
   *  delivery can actually run. */
  fileDeliveryAvailable(): boolean;
}

/** Everything `/channel` is allowed to touch. */
export interface ChannelCommandContext extends ChannelTargetContext {
  /** Evaluated by this module so every call goes through the one
   * location-independent `isOwner` rule, not a precomputed authorization flag. */
  authContext: AuthContext;
  authPolicy: AuthPolicy;
  /** Durable set of channels the bot acts in (seed + `/channel enable`). */
  channels: ChannelRegistry;
  sessions: LiveSessionView;
  /** Called when needed, never snapshotted before the handler runs: a disable
   *  must judge the records as they are AT the check, not as they were when the
   *  interaction arrived. */
  records(): readonly SessionRecord[];
  /** What a declined inbound operation says, owned by the app. */
  inboundDeclined: string;
  /** The enable-target audit. Injected so the app keeps one seam for it. */
  inspectTarget(target: string): Promise<ChannelTargetInspection>;
}

/** What a bot actually needs to run a session in a channel, and the human name
 *  to report when it is missing. `Manage Threads` is deliberately absent: it is
 *  only used to delete the empty thread a failed `/new` leaves behind, which is
 *  a tidiness feature, not a requirement (see `docs/DISCORD-SETUP.md` §4). */
const REQUIRED_CHANNEL_PERMISSIONS: ReadonlyArray<{ flag: bigint; label: string; fileDeliveryOnly?: true }> = [
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.CreatePublicThreads, label: "Create Public Threads" },
  { flag: PermissionFlagsBits.SendMessagesInThreads, label: "Send Messages in Threads" },
  { flag: PermissionFlagsBits.AttachFiles, label: "Attach Files", fileDeliveryOnly: true },
  { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
];

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

function ephemeralReply(content: string): {
  content: string;
  flags: MessageFlags.Ephemeral;
  allowedMentions: typeof NO_MENTIONS.allowedMentions;
} {
  return { content, ...EPHEMERAL, ...NO_MENTIONS };
}

/** Accept either a raw channel id or a `<#id>` mention, as `/end thread:<id>`
 *  already does for threads. A raw id is the point: a channel that has been
 *  DELETED, or that the bot can no longer see, cannot be picked from a channel
 *  option, and that is exactly the one an operator needs to remove. */
export function parseChannelRef(raw: string | null | undefined): string | undefined {
  const t = (raw ?? "").trim();
  if (!t) return undefined;
  const m = /^<#(\d{5,25})>$/.exec(t);
  if (m) return m[1];
  return /^\d{5,25}$/.test(t) ? t : undefined;
}

function privateChannelAccessGuidance(channelId: string): string {
  return (
    `我看不到頻道 \`${channelId}\`，所以無法安全地啟用它。` +
    "請先到該私密頻道的「編輯頻道 → 權限 → 新增成員或身分組」把這個 bot 加進去，" +
    "確認它有 View Channel，再重新執行 `/channel enable`。"
  );
}

/**
 * `/channel enable | disable | list`.
 *
 * Note this only moves the BOT's gate. Whether Discord even offers the command
 * in a channel is a separate, admin-only setting (a bot token cannot set
 * command permissions at all), so a locked-down server may hide `/channel` in
 * the very channel the operator is standing in — hence the `channel:` option,
 * which also lets a DELETED channel be removed by id.
 */
export async function handleChannelCommand(
  interaction: ChatInputCommandInteraction,
  scope: OwnedScope,
  ctx: ChannelCommandContext
): Promise<void> {
  if (!isOwner(ctx.authContext, ctx.authPolicy)) {
    await interaction.reply({ content: "Not authorized.", ...EPHEMERAL });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "list") {
    await channelList(interaction, ctx);
    return;
  }
  const raw = interaction.options.getString("channel");
  const explicit = parseChannelRef(raw);
  // An unparseable value must NOT silently fall back to "here": that would
  // enable or disable a different channel than the one the operator named.
  if ((raw ?? "").trim() && !explicit) {
    await interaction.reply({
      content: "`channel:` 只接受頻道 ID 或 `#頻道` 提及（例如 `123456789012345678` 或 `<#123…>`）。",
      ...EPHEMERAL,
    });
    return;
  }
  const target = explicit ?? interaction.channelId;
  if (sub === "enable") await channelEnable(interaction, target, scope, ctx);
  else if (sub === "disable") await channelDisable(interaction, target, scope, ctx);
}

async function channelList(
  interaction: ChatInputCommandInteraction,
  ctx: ChannelCommandContext
): Promise<void> {
  const counts = new Map<string, number>();
  for (const s of ctx.sessions.values()) {
    counts.set(s.parentChannelId, (counts.get(s.parentChannelId) ?? 0) + 1);
  }
  const entries = ctx.channels.entries();
  const rows = await Promise.all(
    entries.map(async (entry) => {
      const result = await fetchChannelSafe(ctx.discord, entry.id);
      let visibility: string;
      if (result.kind === "ok") {
        const channel = result.channel as {
          guild?: { members?: { me?: unknown } };
        };
        visibility = botCanViewChannel(channel, channel.guild?.members?.me)
          ? "✅ 可見"
          : "⚠️ 已授權但看不到";
      } else if (result.kind === "transient") {
        visibility = "⚠️ 暫時無法稽核";
      } else {
        visibility = "⚠️ 已授權但看不到";
      }
      const source =
        entry.addedBy === CONFIG_SEED_ADDED_BY
          ? "首次啟動預設值"
          : `由 <@${entry.addedBy}> 啟用`;
      return `• <#${entry.id}>（\`${entry.id}\`）· ${visibility} · ${counts.get(entry.id) ?? 0} 個 session · ${source}`;
    })
  );
  const visibleButDisabled: string[] = [];
  for (const channel of ctx.discord.channels.cache.values()) {
    const candidate = channel as unknown as {
      id: string;
      type?: number;
      guildId?: string;
      guild?: { members?: { me?: unknown } };
    };
    if (
      candidate.guildId === ctx.guildId &&
      candidate.type === ChannelType.GuildText &&
      !ctx.channels.has(candidate.id) &&
      botCanViewChannel(candidate, candidate.guild?.members?.me)
    ) {
      visibleButDisabled.push(candidate.id);
    }
  }
  const drift =
    visibleButDisabled.length > 0
      ? `\n\n⚠️ bot 看得到、但尚未在程式內啟用的文字頻道：${visibleButDisabled
          .slice(0, 20)
          .map((id) => `<#${id}>`)
          .join("、")}${visibleButDisabled.length > 20 ? `（另有 ${visibleButDisabled.length - 20} 個）` : ""}`
      : "";
  await interaction.reply(
    ephemeralReply(
      (
        `這個 bot 的頻道白名單與可見度：\n${rows.join("\n") || "（白名單是空的）"}` +
        drift +
        "\n\n只有「已啟用 + bot 可見」的私密文字頻道才能正常工作。見 `docs/CHANNEL-ACCESS.md`。"
      ).slice(0, 1900)
    )
  );
}

/**
 * Enable a channel. Widening, so it follows the same ack-before-allow ordering
 * as `/yolo`: acknowledge FIRST, apply only after Discord confirms, and only
 * if nothing else moved the registry meanwhile. A reply that never lands must
 * not leave the bot answering somewhere the operator was never told about.
 */
async function channelEnable(
  interaction: ChatInputCommandInteraction,
  target: string,
  scope: OwnedScope,
  ctx: ChannelCommandContext
): Promise<void> {
  await interaction.deferReply({ ...EPHEMERAL });
  if (ctx.channels.has(target)) {
    await interaction.editReply(`<#${target}> 已經是啟用狀態了。`);
    return;
  }
  const check = await ctx.inspectTarget(target);
  if (check.error) {
    await interaction.editReply(check.error);
    return;
  }
  const warn = check.missing.length
    ? `\n⚠️ bot 在該頻道缺少這些權限：${check.missing.join("、")}。` +
      `\n仍然可以啟用（Discord 的互動不受頻道權限影響，照樣會送到 bot），但實際發文會失敗。`
    : "";
  // The acknowledgement. If it throws, nothing below runs and the channel
  // stays disabled — the failure direction that is safe.
  await interaction.editReply(
    `正在啟用 <#${target}>，之後這個頻道就能用 \`/new\` 開 session。${warn}`
  );
  // A concurrent enable of THIS target is a harmless durable no-op; a change
  // for a DIFFERENT target is irrelevant. The former is reported by
  // `ChannelRegistry.enable()` as success, and the latter must not make this
  // operator retry a request whose target is still disabled.
  // IMMEDIATELY before the durable write, not on a snapshot taken above it:
  // the permission audit and two editReply round trips sit between, and a
  // registry written by a process that is going away would widen the
  // authorized set with nobody left to answer in it.
  if (scope.lostReason()) {
    await interaction.editReply(ctx.inboundDeclined).catch(() => {});
    return;
  }
  const ok = ctx.channels.enable(target, interaction.user.id);
  await interaction
    .editReply(
      ok
        ? `✅ 已啟用 <#${target}>。${warn}\n` +
          "請把工作頻道保持為私密，並只把這個 bot app 加進它自己的工作頻道。見 `docs/CHANNEL-ACCESS.md`。"
        : `⚠️ 無法寫入頻道清單，**沒有**啟用 <#${target}>（詳見 bot 的日誌）。`
    )
    .catch(() => {});
}

/**
 * Disable a channel. Narrowing, so it persists FIRST and only then reports —
 * a revocation that cannot be written must be reported as a failure, never as
 * success.
 *
 * Refused while the channel still owns work. `blocked` is terminal
 * (`reconcile.ts`), so letting a disable strand live sessions would destroy
 * conversations to tidy up a list; `/end` is the command that is allowed to
 * decide a session is over.
 */
async function channelDisable(
  interaction: ChatInputCommandInteraction,
  target: string,
  scope: OwnedScope,
  ctx: ChannelCommandContext
): Promise<void> {
  if (!ctx.channels.has(target)) {
    await interaction.reply({
      content: `<#${target}> 本來就沒有啟用。`,
      ...EPHEMERAL,
    });
    return;
  }
  const held = channelHolders(target, ctx);
  if (held.length) {
    await interaction.reply({
      content:
        `⚠️ <#${target}> 底下還有 ${held.length} 個 session（或建立中的記錄），先用 \`/end\` 結束它們再停用：\n` +
        held
          .slice(0, 10)
          .map((t) => `• <#${t}> — \`/end\`，討論串已刪除時用 \`/end thread:${t}\``)
          .join("\n") +
        (held.length > 10 ? `\n…另有 ${held.length - 10} 個（用 \`/sessions\` 查看）。` : ""),
      ...EPHEMERAL,
    });
    return;
  }
  // Same, for the narrowing direction. channelHolders walked the live map
  // and the store above; a shutdown since then means this answer is stale.
  if (scope.lostReason()) {
    await interaction.reply(ephemeralReply(ctx.inboundDeclined)).catch(() => {});
    return;
  }
  const ok = ctx.channels.disable(target);
  await interaction.reply({
    content: ok
      ? `✅ 已停用 <#${target}>。bot 不會再回應那裡；若也要讓 bot 從該私密頻道消失，請在頻道權限中移除它。`
      : `⚠️ 無法寫入頻道清單，<#${target}> **仍然是啟用狀態**（詳見 bot 的日誌）。`,
    ...EPHEMERAL,
  });
}

/** Threads that still tie work to `channelId` — live actors plus records that
 *  reconcile would still try to resume or that a `/new` is mid-way through. */
function channelHolders(channelId: string, ctx: ChannelCommandContext): string[] {
  const out = new Set<string>();
  for (const [threadId, s] of ctx.sessions) {
    if (s.parentChannelId === channelId) out.add(threadId);
  }
  for (const r of ctx.records()) {
    if (r.parentChannelId !== channelId) continue;
    if (r.state === "active" || r.state === "creating") out.add(r.threadId);
  }
  return [...out];
}

/** Validate an enable target and report which working permissions the bot is
 *  missing there. Missing permissions are advisory, not a refusal: a
 *  permission is not an authorization, and Discord delivers interactions to
 *  the bot either way. */
export async function inspectChannelTarget(
  target: string,
  ctx: ChannelTargetContext
): Promise<ChannelTargetInspection> {
  const result = await fetchChannelSafe(ctx.discord, target);
  if (result.kind !== "ok") {
    return {
      missing: [],
      error:
        result.kind === "gone"
          ? `找不到頻道 \`${target}\`。請確認 ID 正確，並先把 bot 加進該私密頻道。`
          : result.kind === "no-access"
            ? privateChannelAccessGuidance(target)
            : `無法讀取頻道 \`${target}\`：${
                result.error instanceof Error ? result.error.message : String(result.error)
              }`,
    };
  }
  const c = result.channel as {
    type?: number;
    guildId?: string;
    permissionsFor?: (m: unknown) => { has: (p: bigint) => boolean } | null;
    guild?: { members?: { me?: unknown } };
  };
  if (isObfuscatedChannel(c)) {
    return { missing: [], error: privateChannelAccessGuidance(target) };
  }
  if (c.guildId !== ctx.guildId) {
    return { missing: [], error: `\`${target}\` 不在設定的伺服器裡，拒絕啟用。` };
  }
  if (c.type !== ChannelType.GuildText) {
    return {
      missing: [],
      error:
        `\`${target}\` 不是一般文字頻道（討論串、論壇、公告、語音都不行）。` +
        "session 是「文字頻道底下的討論串」，所以父層必須是文字頻道。",
    };
  }
  const me = c.guild?.members?.me;
  if (!me || typeof c.permissionsFor !== "function") {
    return {
      missing: [],
      error: `無法確認 bot 在頻道 \`${target}\` 的 View Channel 權限，拒絕啟用。`,
    };
  }
  const perms = c.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
    return { missing: [], error: privateChannelAccessGuidance(target) };
  }
  const missing = REQUIRED_CHANNEL_PERMISSIONS.filter(
    (p) => (!p.fileDeliveryOnly || ctx.fileDeliveryAvailable()) && !perms.has(p.flag)
  ).map((p) => p.label);
  return { missing };
}

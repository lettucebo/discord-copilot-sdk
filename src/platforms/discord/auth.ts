/** Authorization context of an incoming Discord interaction/message. */
export interface AuthContext {
  userId: string;
  guildId: string | null;
  channelId: string;
  /** Parent channel id when the channel is a thread; otherwise null. */
  parentId: string | null;
}

/** The configured single-owner lab policy.
 *
 *  `parentChannelIds` is a SET, not a single id: sessions may live under any
 *  channel the owner has enabled (`/channel enable`). On first run the registry
 *  imports `DISCORD_PARENT_CHANNEL_ID` as an ordinary, removable entry. Callers
 *  must rebuild this from the live `ChannelRegistry` on every check — a policy captured once at
 *  construction would make an enable take effect only after a restart. */
export interface AuthPolicy {
  allowedUserIds: ReadonlySet<string>;
  guildId: string;
  parentChannelIds: ReadonlySet<string>;
}

/**
 * Whether the actor is the operator, ignoring WHERE they are.
 *
 * This exists for exactly one caller: `/channel`, which must be usable in a
 * channel that is not enabled yet — otherwise no channel could ever be added
 * (the bootstrap paradox). Everything else must use `isAuthorized`; widening
 * button or autocomplete handling to this would let a click from an unrelated
 * channel drive a session.
 *
 * Trust model, stated deliberately: this makes EVERY id in
 * `DISCORD_ALLOWED_USER_IDS` a channel administrator, able to point the agent's
 * output at a public channel. v1 is a single-owner lab tool, so there is no
 * second admin list — see `docs/CHANNEL-ACCESS.md`.
 */
export function isOwner(ctx: AuthContext, policy: AuthPolicy): boolean {
  if (!policy.allowedUserIds.has(ctx.userId)) return false;
  return ctx.guildId !== null && ctx.guildId === policy.guildId;
}

/**
 * Whether an interaction is allowed. Requires ALL of: an allow-listed user, the
 * configured guild, and a location that is either an ENABLED channel (for /new)
 * or a thread directly under one. This is the v1 access gate — it limits
 * *input*; it does not stop other channel members from *reading* output (use a
 * private channel).
 *
 * It is also the ONLY real boundary: Discord delivers an interaction to the bot
 * regardless of the bot's channel permissions, and answering one does not even
 * require `SEND_MESSAGES`, so no amount of Discord-side configuration can be
 * relied on to keep a command from reaching this function.
 */
export function isAuthorized(ctx: AuthContext, policy: AuthPolicy): boolean {
  if (!isOwner(ctx, policy)) return false;
  return (
    policy.parentChannelIds.has(ctx.channelId) ||
    (ctx.parentId !== null && policy.parentChannelIds.has(ctx.parentId))
  );
}

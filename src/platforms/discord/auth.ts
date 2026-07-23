/** Authorization context of an incoming Discord interaction/message. */
export interface AuthContext {
  userId: string;
  guildId: string | null;
  channelId: string;
  /** Parent channel id when the channel is a thread; otherwise null. */
  parentId: string | null;
}

/** The configured single-owner lab policy. */
export interface AuthPolicy {
  allowedUserIds: ReadonlySet<string>;
  guildId: string;
  parentChannelId: string;
}

/**
 * Whether an interaction is allowed. Requires ALL of: an allow-listed user, the
 * configured guild, and a location that is either the configured parent channel
 * (for /new) or a thread directly under it. This is the v1 access gate — it
 * limits *input*; it does not stop other channel members from *reading* output
 * (use a private channel).
 */
export function isAuthorized(ctx: AuthContext, policy: AuthPolicy): boolean {
  if (!policy.allowedUserIds.has(ctx.userId)) return false;
  if (ctx.guildId === null || ctx.guildId !== policy.guildId) return false;
  return ctx.channelId === policy.parentChannelId || ctx.parentId === policy.parentChannelId;
}

import { PermissionFlagsBits } from "discord.js";

export const CHANNEL_OBFUSCATED = 1 << 17;
export const OBFUSCATED_CHANNEL_NAME = "___hidden___";

interface ChannelFetcher {
  channels: {
    fetch(id: string, options?: { force?: boolean }): Promise<unknown>;
  };
}

export type ChannelFetchResult =
  | { kind: "ok"; channel: object }
  | { kind: "gone" }
  | { kind: "no-access" }
  | { kind: "transient"; error: unknown };

/**
 * Fetch a channel/thread and classify the failure honestly.
 *
 * `force` bypasses discord.js's channel cache. It matters for exactly one
 * caller: re-checking whether LOST access has come back. `channels.fetch(id)`
 * answers from the cache whenever it holds a non-partial object, and what it
 * holds after access was lost is the obfuscated stub — so an unforced re-check
 * can keep reporting "hidden" long after the bot can really see the thread
 * again. Ordinary callers stay on the cached path: forcing REST everywhere
 * would spend rate limit on questions the cache answers correctly.
 */
export async function fetchChannelSafe(
  client: ChannelFetcher,
  id: string,
  opts: { force?: boolean } = {}
): Promise<ChannelFetchResult> {
  try {
    const channel = opts.force
      ? await client.channels.fetch(id, { force: true })
      : await client.channels.fetch(id);
    if (!channel || typeof channel !== "object") return { kind: "gone" };
    if (isObfuscatedChannel(channel)) return { kind: "no-access" };
    return { kind: "ok", channel };
  } catch (error) {
    const discordError = error as { code?: number; status?: number };
    if (discordError.code === 10003) return { kind: "gone" };
    if (discordError.status === 403 || discordError.code === 50001) {
      return { kind: "no-access" };
    }
    return { kind: "transient", error };
  }
}

export function isObfuscatedChannel(channel: unknown): boolean {
  if (!channel || typeof channel !== "object") return false;
  const candidate = channel as {
    name?: unknown;
    flags?: number | bigint | { has?: (flag: number) => boolean };
  };
  if (candidate.name === OBFUSCATED_CHANNEL_NAME) return true;
  if (typeof candidate.flags === "number") {
    return (candidate.flags & CHANNEL_OBFUSCATED) !== 0;
  }
  if (typeof candidate.flags === "bigint") {
    return (candidate.flags & BigInt(CHANNEL_OBFUSCATED)) !== 0n;
  }
  return candidate.flags?.has?.(CHANNEL_OBFUSCATED) === true;
}

export function botCanViewChannel(channel: unknown, member: unknown): boolean {
  if (!channel || typeof channel !== "object" || isObfuscatedChannel(channel)) return false;
  const permissionsFor = (channel as {
    permissionsFor?: (target: unknown) => { has(flag: bigint): boolean } | null;
  }).permissionsFor;
  if (typeof permissionsFor !== "function") return false;
  return permissionsFor.call(channel, member)?.has(PermissionFlagsBits.ViewChannel) === true;
}

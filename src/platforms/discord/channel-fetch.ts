import { PermissionFlagsBits } from "discord.js";

export const CHANNEL_OBFUSCATED = 1 << 17;
export const OBFUSCATED_CHANNEL_NAME = "___hidden___";

interface ChannelFetcher {
  channels: {
    fetch(id: string): Promise<unknown>;
  };
}

export type ChannelFetchResult =
  | { kind: "ok"; channel: object }
  | { kind: "gone" }
  | { kind: "no-access" }
  | { kind: "transient"; error: unknown };

export async function fetchChannelSafe(
  client: ChannelFetcher,
  id: string
): Promise<ChannelFetchResult> {
  try {
    const channel = await client.channels.fetch(id);
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

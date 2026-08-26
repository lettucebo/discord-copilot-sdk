import { describe, expect, it } from "vitest";
import {
  CHANNEL_OBFUSCATED,
  botCanViewChannel,
  fetchChannelSafe,
  isObfuscatedChannel,
} from "../src/platforms/discord/channel-fetch.js";

const client = (result: unknown, error?: unknown) => ({
  channels: {
    fetch: async () => {
      if (error) throw error;
      return result;
    },
  },
});

describe("fetchChannelSafe", () => {
  it("separates success, absence, missing access, and transient failures", async () => {
    const channel = { id: "c1" };
    await expect(fetchChannelSafe(client(channel), "c1")).resolves.toEqual({ kind: "ok", channel });
    await expect(fetchChannelSafe(client({ id: "c1", name: "___hidden___" }), "c1")).resolves.toEqual({
      kind: "no-access",
    });
    await expect(fetchChannelSafe(client(null), "c1")).resolves.toEqual({ kind: "gone" });
    await expect(fetchChannelSafe(client(undefined, { code: 10003 }), "c1")).resolves.toEqual({ kind: "gone" });
    await expect(fetchChannelSafe(client(undefined, { code: 50001 }), "c1")).resolves.toEqual({
      kind: "no-access",
    });
    await expect(fetchChannelSafe(client(undefined, { status: 403 }), "c1")).resolves.toEqual({
      kind: "no-access",
    });
    const error = new Error("network");
    await expect(fetchChannelSafe(client(undefined, error), "c1")).resolves.toEqual({
      kind: "transient",
      error,
    });
  });
});

describe("Discord channel visibility", () => {
  it("detects both documented obfuscation forms", () => {
    expect(isObfuscatedChannel({ name: "___hidden___" })).toBe(true);
    expect(isObfuscatedChannel({ name: "visible", flags: CHANNEL_OBFUSCATED })).toBe(true);
    expect(isObfuscatedChannel({ name: "visible", flags: { has: (flag: number) => flag === CHANNEL_OBFUSCATED } })).toBe(
      true
    );
    expect(isObfuscatedChannel({ name: "visible", flags: 0 })).toBe(false);
  });

  it("requires a visible channel and explicit View Channel permission", () => {
    const member = {};
    expect(
      botCanViewChannel(
        { name: "visible", permissionsFor: () => ({ has: () => true }) },
        member
      )
    ).toBe(true);
    expect(
      botCanViewChannel(
        { name: "___hidden___", permissionsFor: () => ({ has: () => true }) },
        member
      )
    ).toBe(false);
    expect(botCanViewChannel({ name: "visible", permissionsFor: () => null }, member)).toBe(false);
  });

  it("preserves the discord.js channel as permissionsFor's this context", () => {
    interface ContextSensitiveChannel {
      name: string;
      canView: boolean;
      permissionsFor(this: ContextSensitiveChannel, member: unknown): {
        has(flag: bigint): boolean;
      };
    }
    const channel: ContextSensitiveChannel = {
      name: "visible",
      canView: true,
      permissionsFor(member) {
        expect(member).toBe(operator);
        return { has: () => this.canView };
      },
    };
    const operator = {};

    expect(botCanViewChannel(channel, operator)).toBe(true);
  });
});

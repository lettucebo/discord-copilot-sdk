import { describe, it, expect } from "vitest";
import { encodePermissionId, decodePermissionId } from "../src/platforms/discord/custom-id.js";
import { isAuthorized } from "../src/platforms/discord/auth.js";

describe("custom-id", () => {
  it("round-trips allow/deny + nonce", () => {
    const id = encodePermissionId("abc-123", "allow");
    expect(id).toBe("dp:perm:allow:abc-123");
    expect(decodePermissionId(id)).toEqual({ nonce: "abc-123", action: "allow" });
    expect(decodePermissionId(encodePermissionId("n", "deny"))).toEqual({ nonce: "n", action: "deny" });
  });

  it("rejects malformed / foreign ids", () => {
    expect(decodePermissionId("other:perm:allow:n")).toBeUndefined();
    expect(decodePermissionId("dp:x:allow:n")).toBeUndefined();
    expect(decodePermissionId("dp:perm:maybe:n")).toBeUndefined();
    expect(decodePermissionId("dp:perm:allow:")).toBeUndefined();
    expect(decodePermissionId("dp:perm:allow")).toBeUndefined();
  });

  it("stays within Discord's 100-char custom id limit for a uuid nonce", () => {
    expect(encodePermissionId("123e4567-e89b-12d3-a456-426614174000", "deny").length).toBeLessThanOrEqual(100);
  });
});

describe("isAuthorized", () => {
  const policy = {
    allowedUserIds: new Set(["u1"]),
    guildId: "g1",
    parentChannelId: "c1",
  };

  it("allows an allow-listed user in the parent channel", () => {
    expect(isAuthorized({ userId: "u1", guildId: "g1", channelId: "c1", parentId: null }, policy)).toBe(true);
  });

  it("allows an allow-listed user in a thread under the parent", () => {
    expect(isAuthorized({ userId: "u1", guildId: "g1", channelId: "t9", parentId: "c1" }, policy)).toBe(true);
  });

  it("denies a non-allow-listed user", () => {
    expect(isAuthorized({ userId: "u2", guildId: "g1", channelId: "c1", parentId: null }, policy)).toBe(false);
  });

  it("denies a wrong guild", () => {
    expect(isAuthorized({ userId: "u1", guildId: "gX", channelId: "c1", parentId: null }, policy)).toBe(false);
    expect(isAuthorized({ userId: "u1", guildId: null, channelId: "c1", parentId: null }, policy)).toBe(false);
  });

  it("denies a channel/thread outside the parent", () => {
    expect(isAuthorized({ userId: "u1", guildId: "g1", channelId: "cX", parentId: "cY" }, policy)).toBe(false);
  });
});

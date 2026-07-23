import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config.js";

const base = {
  DISCORD_BOT_TOKEN: "tok",
  DISCORD_ALLOWED_USER_IDS: "123456789012345",
  DISCORD_GUILD_ID: "222333444555666",
  DISCORD_PARENT_CHANNEL_ID: "777888999000111",
  CONTROLLED_REPO_PATH: "C:/tmp/throwaway",
};

describe("parseConfig", () => {
  it("parses a valid config and applies defaults", () => {
    const c = parseConfig({ ...base });
    expect(c.DISCORD_ALLOWED_USER_IDS).toEqual(["123456789012345"]);
    expect(c.DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(c.DEFAULT_CONTEXT_TIER).toBe("default");
    expect(c.PERMISSION_POLICY).toBe("ask");
  });

  it("splits multiple allowed user ids", () => {
    const c = parseConfig({ ...base, DISCORD_ALLOWED_USER_IDS: "111111111111, 222222222222 ,333333333333" });
    expect(c.DISCORD_ALLOWED_USER_IDS).toEqual(["111111111111", "222222222222", "333333333333"]);
  });

  it("honors long_context tier", () => {
    expect(parseConfig({ ...base, DEFAULT_CONTEXT_TIER: "long_context" }).DEFAULT_CONTEXT_TIER).toBe("long_context");
  });

  it("throws listing every missing/invalid field", () => {
    expect(() => parseConfig({})).toThrowError(/DISCORD_BOT_TOKEN/);
    expect(() => parseConfig({ ...base, DISCORD_GUILD_ID: "not-a-snowflake" })).toThrowError(/DISCORD_GUILD_ID/);
    expect(() => parseConfig({ ...base, DISCORD_ALLOWED_USER_IDS: "abc" })).toThrowError(/snowflake/);
  });

  it("rejects an unknown context tier", () => {
    expect(() => parseConfig({ ...base, DEFAULT_CONTEXT_TIER: "ultra" })).toThrowError(/DEFAULT_CONTEXT_TIER/);
  });
});

import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config.js";

const base = {
  DISCORD_BOT_TOKEN: "tok",
  DISCORD_ALLOWED_USER_IDS: "123456789012345",
  DISCORD_GUILD_ID: "222333444555666",
  DISCORD_PARENT_CHANNEL_ID: "777888999000111",
  REPOS_ROOT: "C:/tmp/throwaway-repos",
};

describe("parseConfig", () => {
  it("parses a valid config and applies defaults", () => {
    const c = parseConfig({ ...base });
    expect(c.DISCORD_ALLOWED_USER_IDS).toEqual(["123456789012345"]);
    expect(c.DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(c.DEFAULT_CONTEXT_TIER).toBe("default");
    expect(c.PERMISSION_POLICY).toBe("ask");
    expect(c.REPO_CLONE_HOST_POLICY).toBe("github");
    expect(c.REPO_CLONE_ALLOWED_HOSTS).toEqual([]);
    expect(c.REPO_CLONE_TIMEOUT_MS).toBe(300_000);
    expect(c.DEFAULT_REPO).toBeUndefined();
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

  it("REJECTS a removed key rather than ignoring it", () => {
    // z.object() drops unknown keys, so without an explicit check a .env still
    // naming CONTROLLED_REPO_PATH would boot with a completely different repo
    // boundary than the one written in the file. Both removed keys used to
    // DEFINE that boundary.
    expect(() => parseConfig({ ...base, CONTROLLED_REPO_PATH: "C:/old" })).toThrowError(
      /CONTROLLED_REPO_PATH/
    );
    expect(() => parseConfig({ ...base, SESSION_ISOLATION: "worktree" })).toThrowError(
      /SESSION_ISOLATION/
    );
    // …but an empty leftover line is not a configuration.
    expect(() => parseConfig({ ...base, CONTROLLED_REPO_PATH: "", SESSION_ISOLATION: "" })).not.toThrow();
  });

  it("requires an allowlist to actually list hosts", () => {
    expect(() => parseConfig({ ...base, REPO_CLONE_HOST_POLICY: "allowlist" })).toThrowError(
      /REPO_CLONE_ALLOWED_HOSTS/
    );
    const c = parseConfig({
      ...base,
      REPO_CLONE_HOST_POLICY: "allowlist",
      REPO_CLONE_ALLOWED_HOSTS: "git.example.com, other.example.com",
    });
    expect(c.REPO_CLONE_ALLOWED_HOSTS).toEqual(["git.example.com", "other.example.com"]);
  });

  it("has no 'any public host' clone policy — hostname text cannot prove a host is external", () => {
    expect(() => parseConfig({ ...base, REPO_CLONE_HOST_POLICY: "public" })).toThrowError(
      /REPO_CLONE_HOST_POLICY/
    );
  });

  it("treats DEFAULT_REPO as a NAME, never a path", () => {
    expect(parseConfig({ ...base, DEFAULT_REPO: "career-ops" }).DEFAULT_REPO).toBe("career-ops");
    for (const bad of ["a/b", "a\\b", "../escape", "C:\\Source\\Repos\\x", ".."]) {
      expect(() => parseConfig({ ...base, DEFAULT_REPO: bad })).toThrowError(/DEFAULT_REPO/);
    }
  });
});

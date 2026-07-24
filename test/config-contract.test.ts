import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config.js";
import { validateConfig, MANAGED_KEYS } from "../scripts/lib/validate.mjs";

/**
 * Contract test: the installer's pure validators (scripts/lib/validate.mjs) must
 * accept/reject the same configs as the runtime schema (src/config.ts). We run a
 * corpus through BOTH and assert they agree, so the two can't silently drift.
 */

const base = () => ({
  DISCORD_BOT_TOKEN: "tok.en",
  DISCORD_ALLOWED_USER_IDS: "111111111111111111",
  DISCORD_GUILD_ID: "222222222222222222",
  DISCORD_PARENT_CHANNEL_ID: "333333333333333333",
  CONTROLLED_REPO_PATH: "C:\\Source\\Repos\\x",
});

// runtimeAccepts: does the real zod schema accept it (no throw)?
function runtimeAccepts(values) {
  try {
    parseConfig(values);
    return true;
  } catch {
    return false;
  }
}

const corpus = [
  { name: "valid minimal", values: base() },
  { name: "valid with DEV_GUILD_ID", values: { ...base(), DEV_GUILD_ID: "111111111" } },
  { name: "empty DEV_GUILD_ID (shipped in .env.example) is accepted as unset", values: { ...base(), DEV_GUILD_ID: "" } },
  { name: "valid multi user ids", values: { ...base(), DISCORD_ALLOWED_USER_IDS: "111111111, 222222222" } },
  { name: "valid long_context", values: { ...base(), DEFAULT_CONTEXT_TIER: "long_context" } },
  { name: "missing token", values: { ...base(), DISCORD_BOT_TOKEN: "" } },
  { name: "missing user ids", values: { ...base(), DISCORD_ALLOWED_USER_IDS: "" } },
  { name: "non-snowflake guild", values: { ...base(), DISCORD_GUILD_ID: "not-a-number" } },
  { name: "short snowflake", values: { ...base(), DISCORD_GUILD_ID: "12" } },
  { name: "bad user id in list", values: { ...base(), DISCORD_ALLOWED_USER_IDS: "111111111, abc" } },
  { name: "missing repo path", values: { ...base(), CONTROLLED_REPO_PATH: "" } },
  { name: "bad dev guild id", values: { ...base(), DEV_GUILD_ID: "xx" } },
  { name: "bad context tier", values: { ...base(), DEFAULT_CONTEXT_TIER: "huge" } },
  { name: "whitespace-only token", values: { ...base(), DISCORD_BOT_TOKEN: "   " } },
  { name: "whitespace-only repo path", values: { ...base(), CONTROLLED_REPO_PATH: "  " } },
];

describe("installer validators ⇄ runtime config contract", () => {
  for (const c of corpus) {
    it(`agrees on: ${c.name}`, () => {
      const installerOk = validateConfig(c.values).ok;
      const runtimeOk = runtimeAccepts(c.values);
      expect(installerOk).toBe(runtimeOk);
    });
  }

  it("every required runtime key (minus defaulted) is a managed installer key", () => {
    const managed = new Set(MANAGED_KEYS.map((m) => m.key));
    for (const k of [
      "DISCORD_BOT_TOKEN",
      "DISCORD_ALLOWED_USER_IDS",
      "DISCORD_GUILD_ID",
      "DISCORD_PARENT_CHANNEL_ID",
      "CONTROLLED_REPO_PATH",
    ]) {
      expect(managed.has(k)).toBe(true);
    }
  });
});

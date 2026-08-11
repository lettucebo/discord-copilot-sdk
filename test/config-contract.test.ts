import { describe, it, expect } from "vitest";
import { parseConfig, REMOVED_KEYS } from "../src/config.js";
import { validateConfig, MANAGED_KEYS, REMOVED_KEYS as INSTALLER_REMOVED_KEYS } from "../scripts/lib/validate.mjs";

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
  REPOS_ROOT: "C:\\Source\\Repos",
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
  { name: "repo skills default", values: { ...base(), ENABLE_REPO_SKILLS: "true" } },
  { name: "repo skills may be disabled", values: { ...base(), ENABLE_REPO_SKILLS: "false" } },
  { name: "user skills default", values: { ...base(), ENABLE_USER_SKILLS: "true" } },
  { name: "user skills may be disabled", values: { ...base(), ENABLE_USER_SKILLS: "false" } },
  { name: "empty skill switches fall back to defaults", values: { ...base(), ENABLE_REPO_SKILLS: "", ENABLE_USER_SKILLS: "" } },
  { name: "case-drifted repo skill switch is rejected", values: { ...base(), ENABLE_REPO_SKILLS: "True" } },
  { name: "non-boolean user skill switch is rejected", values: { ...base(), ENABLE_USER_SKILLS: "yes" } },
  { name: "missing token", values: { ...base(), DISCORD_BOT_TOKEN: "" } },
  { name: "missing user ids", values: { ...base(), DISCORD_ALLOWED_USER_IDS: "" } },
  { name: "non-snowflake guild", values: { ...base(), DISCORD_GUILD_ID: "not-a-number" } },
  { name: "short snowflake", values: { ...base(), DISCORD_GUILD_ID: "12" } },
  { name: "bad user id in list", values: { ...base(), DISCORD_ALLOWED_USER_IDS: "111111111, abc" } },
  { name: "missing repos root", values: { ...base(), REPOS_ROOT: "" } },
  { name: "bad dev guild id", values: { ...base(), DEV_GUILD_ID: "xx" } },
  { name: "bad context tier", values: { ...base(), DEFAULT_CONTEXT_TIER: "huge" } },
  { name: "whitespace-only token", values: { ...base(), DISCORD_BOT_TOKEN: "   " } },
  { name: "whitespace-only repos root", values: { ...base(), REPOS_ROOT: "  " } },
  { name: "whitespace-only model", values: { ...base(), DEFAULT_MODEL: "   " } },

  // --- removed keys: rejected, never ignored -------------------------------
  { name: "leftover CONTROLLED_REPO_PATH is rejected", values: { ...base(), CONTROLLED_REPO_PATH: "C:\\Source\\Repos\\x" } },
  { name: "leftover SESSION_ISOLATION is rejected", values: { ...base(), SESSION_ISOLATION: "worktree" } },
  { name: "an EMPTY leftover key is not a leftover", values: { ...base(), CONTROLLED_REPO_PATH: "" } },

  {
    name: "whitespace-only removed key is not a configuration",
    values: { ...base(), CONTROLLED_REPO_PATH: "   " },
  },
  { name: "empty clone host policy falls back to the default", values: { ...base(), REPO_CLONE_HOST_POLICY: "" } },
  { name: "empty clone timeout falls back to the default", values: { ...base(), REPO_CLONE_TIMEOUT_MS: "" } },

  // --- DEFAULT_REPO is a name, not a path ----------------------------------
  { name: "valid DEFAULT_REPO", values: { ...base(), DEFAULT_REPO: "career-ops" } },
  { name: "empty DEFAULT_REPO is unset", values: { ...base(), DEFAULT_REPO: "" } },
  { name: "DEFAULT_REPO with a separator is rejected", values: { ...base(), DEFAULT_REPO: "a/b" } },
  { name: "DEFAULT_REPO with a backslash is rejected", values: { ...base(), DEFAULT_REPO: "a\\b" } },
  { name: "DEFAULT_REPO with .. is rejected", values: { ...base(), DEFAULT_REPO: "..\\escape" } },
  { name: "DEFAULT_REPO as an absolute path is rejected", values: { ...base(), DEFAULT_REPO: "C:\\Source\\Repos\\x" } },

  // --- clone host policy ----------------------------------------------------
  { name: "default clone policy", values: { ...base(), REPO_CLONE_HOST_POLICY: "github" } },
  { name: "unknown clone policy is rejected", values: { ...base(), REPO_CLONE_HOST_POLICY: "public" } },
  {
    name: "allowlist policy WITHOUT hosts is rejected",
    values: { ...base(), REPO_CLONE_HOST_POLICY: "allowlist" },
  },
  {
    name: "allowlist policy WITH hosts is accepted",
    values: { ...base(), REPO_CLONE_HOST_POLICY: "allowlist", REPO_CLONE_ALLOWED_HOSTS: "git.example.com" },
  },
  {
    name: "allowlist policy with a blank host list is rejected",
    values: { ...base(), REPO_CLONE_HOST_POLICY: "allowlist", REPO_CLONE_ALLOWED_HOSTS: " , " },
  },

  // --- clone timeout --------------------------------------------------------
  { name: "valid clone timeout", values: { ...base(), REPO_CLONE_TIMEOUT_MS: "600000" } },
  { name: "non-numeric clone timeout is rejected", values: { ...base(), REPO_CLONE_TIMEOUT_MS: "soon" } },
  { name: "absurdly small clone timeout is rejected", values: { ...base(), REPO_CLONE_TIMEOUT_MS: "5" } },
  { name: "absurdly large clone timeout is rejected", values: { ...base(), REPO_CLONE_TIMEOUT_MS: "99999999" } },
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
      "REPOS_ROOT",
    ]) {
      expect(managed.has(k)).toBe(true);
    }
  });

  it("manages both skill source switches with a secure default", () => {
    const skills = MANAGED_KEYS.filter(
      (spec) => spec.key === "ENABLE_REPO_SKILLS" || spec.key === "ENABLE_USER_SKILLS"
    );
    expect(skills).toHaveLength(2);
    expect(skills.map((spec) => spec.defaultValue)).toEqual(["true", "true"]);
  });

  it("the removed-key lists on both sides name exactly the same keys", () => {
    // Drift here is how the installer writes a .env the bot refuses to start on.
    expect([...INSTALLER_REMOVED_KEYS].sort()).toEqual(REMOVED_KEYS.map(([k]) => k).sort());
  });

  it("no removed key is also a managed key", () => {
    const managed = new Set(MANAGED_KEYS.map((m) => m.key));
    for (const k of INSTALLER_REMOVED_KEYS) expect(managed.has(k)).toBe(false);
  });

  it("the removed-key error NAMES the replacement, so the fix needs no docs", () => {
    let msg = "";
    try {
      parseConfig({ ...base(), CONTROLLED_REPO_PATH: "C:\\x" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("CONTROLLED_REPO_PATH");
    expect(msg).toContain("REPOS_ROOT");
    expect(msg).toContain("DEFAULT_REPO");
  });

  it("runtime preserves REPOS_ROOT EXACTLY (no trimming that would redirect the boundary)", () => {
    // A trailing space is a real, different Unix directory — the runtime must not
    // silently transform it away from what the installer wrote.
    const p = "/tmp/disposable ";
    const cfg = parseConfig({ ...base(), REPOS_ROOT: p });
    expect(cfg.REPOS_ROOT).toBe(p);
    // token likewise preserved verbatim
    const cfg2 = parseConfig({ ...base(), DISCORD_BOT_TOKEN: " tok " });
    expect(cfg2.DISCORD_BOT_TOKEN).toBe(" tok ");
  });
});

import { describe, it, expect } from "vitest";
import { sanitizeRuntimeEnv } from "../src/copilot/sdk.js";

describe("sanitizeRuntimeEnv (secrets must not reach the agent's process env)", () => {
  it("strips the bot token and every DISCORD_* setting", () => {
    const out = sanitizeRuntimeEnv({
      DISCORD_BOT_TOKEN: "secret",
      DISCORD_ALLOWED_USER_IDS: "123",
      DISCORD_COPILOT_SDK_INSTANCE_ID: "work",
      PATH: "/usr/bin",
    });
    expect(out["DISCORD_BOT_TOKEN"]).toBeUndefined();
    expect(out["DISCORD_ALLOWED_USER_IDS"]).toBeUndefined();
    expect(out["DISCORD_COPILOT_SDK_INSTANCE_ID"]).toBeUndefined();
    expect(out["PATH"]).toBe("/usr/bin"); // unrelated vars survive
  });

  it("still strips the PRE-RENAME `DISCOPILOT_` prefix", () => {
    // The project was renamed discopilot → discord-copilot-sdk. A variable left
    // over from the old name (shell profile, wrapper script, scheduled task)
    // must not start leaking to the agent just because the prefix changed.
    // A blanket search-and-replace during the rename silently dropped this
    // branch — hence the explicit regression test.
    const out = sanitizeRuntimeEnv({ DISCOPILOT_INSTANCE_ID: "work", DISCOPILOT_LOCALE: "zh-TW" });
    expect(out["DISCOPILOT_INSTANCE_ID"]).toBeUndefined();
    expect(out["DISCOPILOT_LOCALE"]).toBeUndefined();
  });

  it("matches case-insensitively (env var casing is not guaranteed)", () => {
    const out = sanitizeRuntimeEnv({ discord_bot_token: "secret", Discopilot_Locale: "zh" });
    expect(out["discord_bot_token"]).toBeUndefined();
    expect(out["Discopilot_Locale"]).toBeUndefined();
  });

  it("keeps a variable that merely CONTAINS the prefix rather than starting with it", () => {
    const out = sanitizeRuntimeEnv({ MY_DISCORD_TOKEN: "keep" });
    expect(out["MY_DISCORD_TOKEN"]).toBe("keep");
  });
});

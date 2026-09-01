import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import { sanitizeRuntimeEnv, stopCopilotClient } from "../src/copilot/sdk.js";

describe("Copilot SDK/runtime tuple", () => {
  it("pins the bundled runtime exactly because installs have no committed lockfile", () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { dependencies?: Record<string, string>; overrides?: Record<string, string> };

    expect(pkg.dependencies?.["@github/copilot-sdk"]).toBe("1.0.11");
    expect(pkg.overrides?.["@github/copilot"]).toBe("1.0.80");

    const requireFromSdk = createRequire(createRequire(import.meta.url).resolve("@github/copilot-sdk"));
    const installedRuntime = JSON.parse(
      fs.readFileSync(requireFromSdk.resolve("@github/copilot/package.json"), "utf8")
    ) as { version?: string };
    expect(installedRuntime.version).toBe(pkg.overrides?.["@github/copilot"]);
  });
});

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

describe("stopCopilotClient (a reported cleanup failure IS a failure)", () => {
  it("resolves when the client reports no errors", async () => {
    await expect(stopCopilotClient({ stop: async () => [] })).resolves.toBeUndefined();
  });

  it("rejects when the client FULFILS with errors", async () => {
    // `CopilotClient.stop(): Promise<Error[]>` reports a cleanup that did not
    // work by fulfilling, not by rejecting. Awaiting it for the side effect
    // therefore read every one of those failures as a clean stop.
    const reported = [new Error("child did not exit"), new Error("socket still open")];
    await expect(stopCopilotClient({ stop: async () => reported })).rejects.toThrow(
      /reported 2 cleanup error/
    );
  });

  it("carries the reported errors, so a log says what actually failed", async () => {
    const reported = [new Error("child did not exit")];
    const err = await stopCopilotClient({ stop: async () => reported }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual(reported);
  });

  it("still propagates an outright rejection", async () => {
    await expect(
      stopCopilotClient({
        stop: async () => {
          throw new Error("rpc closed");
        },
      })
    ).rejects.toThrow(/rpc closed/);
  });
});

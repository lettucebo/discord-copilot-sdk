import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("update bootstraps", () => {
  it("ships a local and network-safe Windows entrypoint", () => {
    const file = path.join(ROOT, "update.ps1");
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");

    expect(text).toContain("scripts\\update.mjs");
    expect(text).toContain("DISCORD_COPILOT_SDK_UPDATE_ROOT");
    expect(text).toContain("Invoke-RestMethod");
    expect(text).not.toMatch(/\|\s*iex\b/i);
  });

  it("ships a local and network-safe POSIX entrypoint", () => {
    const file = path.join(ROOT, "update.sh");
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");

    expect(text.startsWith("#!")).toBe(true);
    expect(text).toContain("scripts/update.mjs");
    expect(text).toContain("DISCORD_COPILOT_SDK_UPDATE_ROOT");
    expect(text).toContain("curl");
  });
});

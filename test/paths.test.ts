import { describe, it, expect } from "vitest";
import { legacyNameWarnings, LEGACY_STATE_DIR_NAME, LEGACY_ENV_PREFIX } from "../src/core/paths.js";

describe("legacyNameWarnings (post-rename `discopilot` leftovers)", () => {
  it("says nothing when there is nothing left over", () => {
    expect(legacyNameWarnings({}, false)).toEqual([]);
    expect(legacyNameWarnings({ PATH: "/usr/bin", DISCORD_BOT_TOKEN: "x" }, false)).toEqual([]);
  });

  it("reports a leftover state directory WITHOUT claiming it was migrated", () => {
    // Silently adopting it would resurrect saved "Always (this repo)" approval
    // grants the operator may have forgotten — the one direction this project
    // never moves in. Losing them is the fail-safe outcome; saying nothing is
    // not, because the resumable thread would also vanish unexplained.
    const w = legacyNameWarnings({}, true).join("\n");
    expect(w).toContain(LEGACY_STATE_DIR_NAME);
    expect(w).toMatch(/not (be )?read|ignored/i);
    expect(w).toMatch(/approval/i); // tells them grants are deliberately not restored
  });

  it("names the leftover env vars it found, and only those", () => {
    const w = legacyNameWarnings(
      { DISCOPILOT_INSTANCE_ID: "work", DISCOPILOT_LOCALE: "zh-TW", PATH: "/usr/bin" },
      false
    ).join("\n");
    expect(w).toContain("DISCOPILOT_INSTANCE_ID");
    expect(w).toContain("DISCOPILOT_LOCALE");
    expect(w).not.toContain("PATH");
  });

  it("points at the replacement prefix so the fix is obvious", () => {
    const w = legacyNameWarnings({ DISCOPILOT_INSTANCE_ID: "work" }, false).join("\n");
    expect(w).toContain("DISCORD_COPILOT_SDK_INSTANCE_ID");
  });

  it("does not warn about a variable that merely CONTAINS the legacy prefix", () => {
    expect(legacyNameWarnings({ MY_DISCOPILOT_THING: "x" }, false)).toEqual([]);
  });

  it("matches the legacy prefix case-insensitively (env casing is not guaranteed)", () => {
    const w = legacyNameWarnings({ Discopilot_Locale: "zh" }, false).join("\n");
    expect(w).toContain("Discopilot_Locale");
  });

  it("reports both kinds at once", () => {
    expect(legacyNameWarnings({ DISCOPILOT_LOCALE: "zh" }, true).length).toBe(2);
  });

  it("exposes the legacy names it checks, so they can't drift from the docs", () => {
    expect(LEGACY_STATE_DIR_NAME).toBe(".discopilot");
    expect(LEGACY_ENV_PREFIX).toBe("DISCOPILOT_");
  });
});

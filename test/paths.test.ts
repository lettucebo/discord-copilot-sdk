import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  legacyNameWarnings,
  LEGACY_STATE_DIR_NAME,
  LEGACY_ENV_PREFIX,
  STATE_DIR_NAME,
  stateDir,
  worktreeRoot,
} from "../src/core/paths.js";

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

describe("worktreeRoot (trust-boundary sibling)", () => {
  it("is a SIBLING of the state dir, never a descendant of it", () => {
    // The whole point: `stateDir()` holds approvals.json, the session store and
    // the instance lock. If a worktree lived under it, every agent's cwd would
    // sit below the bot's own trust store, and one approved relative-path write
    // would be enough to grant durable auto-approval for arbitrary executables.
    const rel = path.relative(stateDir(), worktreeRoot());
    expect(rel.startsWith("..")).toBe(true);
    expect(path.dirname(worktreeRoot())).toBe(path.dirname(stateDir()));
  });

  it("derives its name from the state dir name, so the two cannot drift apart", () => {
    expect(worktreeRoot()).toBe(path.join(os.homedir(), `${STATE_DIR_NAME}-worktrees`));
    expect(stateDir()).toBe(path.join(os.homedir(), STATE_DIR_NAME));
  });

  it("does NOT create the directory — validators call it before any worktree exists", () => {
    // `stateDir()` mkdirs on purpose; this one must not, or every rejected
    // config would leave an empty directory behind as a side effect of merely
    // *checking* a path.
    const src = readFileSync(new URL("../src/core/paths.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function worktreeRoot"));
    expect(body.slice(0, body.indexOf("}"))).not.toContain("mkdir");
  });
});

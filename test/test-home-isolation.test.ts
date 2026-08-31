import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { stateDir, STATE_DIR_NAME, worktreeRoot } from "../src/core/paths.js";

describe("Vitest home isolation", () => {
  it("redirects every in-process test file before product paths are resolved", () => {
    const isolatedHome = process.env["DISCORD_COPILOT_SDK_VITEST_HOME"];
    const runHome = process.env["DISCORD_COPILOT_SDK_VITEST_RUN_HOME"];

    expect(isolatedHome).toBeTruthy();
    expect(runHome).toBeTruthy();
    expect(path.dirname(isolatedHome!)).toBe(runHome);
    expect(os.homedir()).toBe(isolatedHome);
    expect(stateDir()).toBe(path.join(isolatedHome!, STATE_DIR_NAME));
    expect(worktreeRoot()).toBe(path.join(isolatedHome!, `${STATE_DIR_NAME}-worktrees`));
  });
});

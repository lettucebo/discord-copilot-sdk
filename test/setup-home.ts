import { afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const runHome = process.env["DISCORD_COPILOT_SDK_VITEST_RUN_HOME"];
if (!runHome) throw new Error("Vitest global home setup did not run");
const isolatedHome = fs.mkdtempSync(path.join(runHome, "file-"));

process.env["HOME"] = isolatedHome;
process.env["USERPROFILE"] = isolatedHome;
process.env["DISCORD_COPILOT_SDK_VITEST_HOME"] = isolatedHome;

afterAll(() => {
  delete process.env["DISCORD_COPILOT_SDK_VITEST_HOME"];
  process.env["HOME"] = runHome;
  process.env["USERPROFILE"] = runHome;
  try {
    fs.rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (err) {
    // The run-level teardown owns the parent and gets a second bounded attempt.
    // Do not turn an otherwise-green file red before that final sweep runs.
    console.warn(`Vitest per-file home cleanup deferred: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 30_000);

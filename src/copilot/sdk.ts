import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { CopilotClient } from "@github/copilot-sdk";

/** The SDK version this build is written and tested against. The user requested
 *  tracking the latest published version (npm dist-tag `latest`). */
export const EXPECTED_SDK_VERSION = "1.0.7-preview.3";

/** Read the installed @github/copilot-sdk version from its package.json on disk.
 *  (The package's `exports` map hides package.json from `require`, so we resolve
 *  the entry and walk up to the package root — the entry may be nested a few
 *  levels deep, e.g. dist/cjs/index.js, so we don't assume a fixed depth.) */
export function installedSdkVersion(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@github/copilot-sdk");
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "@github/copilot-sdk" && pkg.version) return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

export interface SdkCompat {
  installed: string;
  expected: string;
  ok: boolean;
}

/** Startup compatibility check: does the installed SDK match what we target? */
export function checkSdkCompat(): SdkCompat {
  const installed = installedSdkVersion();
  return { installed, expected: EXPECTED_SDK_VERSION, ok: installed === EXPECTED_SDK_VERSION };
}

export interface SelfCheckResult {
  version: string;
  modelCount: number;
  sample?: { id: string; contextWindow?: number; efforts?: string[] };
}

interface ModelLike {
  id: string;
  capabilities?: { limits?: { max_context_window_tokens?: number } };
  supportedReasoningEfforts?: string[];
}

/** Connect to the local Copilot runtime and enumerate models. Proves the SDK
 *  wiring + local auth work end to end. Uses the host's logged-in Copilot. */
export async function sdkSelfCheck(): Promise<SelfCheckResult> {
  const client = new CopilotClient({ useLoggedInUser: true, logLevel: "error" });
  await client.start();
  try {
    const models = (await client.listModels()) as unknown as ModelLike[];
    const m = models.find((x) => /sonnet|gpt/i.test(x.id)) ?? models[0];
    const sample = m
      ? {
          id: m.id,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens,
          efforts: m.supportedReasoningEfforts,
        }
      : undefined;
    return { version: installedSdkVersion(), modelCount: models.length, ...(sample ? { sample } : {}) };
  } finally {
    await client.stop();
  }
}

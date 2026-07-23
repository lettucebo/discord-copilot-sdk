import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";

/** Walk up from `startDir` to find a package.json whose `name` matches, and
 *  return a field from it. Robust to nested dist entry points. */
function readPkgField<T>(
  startDir: string,
  name: string,
  pick: (pkg: Record<string, unknown>) => T | undefined
): T | undefined {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (pkg["name"] === name) {
        const v = pick(pkg);
        if (v !== undefined) return v;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Version of @github/copilot-sdk actually installed in node_modules. */
export function installedSdkVersion(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@github/copilot-sdk");
  return (
    readPkgField(path.dirname(entry), "@github/copilot-sdk", (p) => p["version"] as string) ??
    "unknown"
  );
}

/** SDK version discopilot declares — single source of truth is our own
 *  package.json dependency pin (no duplicated constant). */
export function declaredSdkVersion(): string {
  return (
    readPkgField(
      path.dirname(fileURLToPath(import.meta.url)),
      "discopilot",
      (p) => (p["dependencies"] as Record<string, string> | undefined)?.["@github/copilot-sdk"]
    ) ?? "unknown"
  );
}

export interface SdkCompat {
  installed: string;
  declared: string;
  ok: boolean;
}

/** Does the installed SDK match the version discopilot was built against? */
export function checkSdkCompat(): SdkCompat {
  const installed = installedSdkVersion();
  const declared = declaredSdkVersion();
  return { installed, declared, ok: installed === declared };
}

/** Build the sanitized environment handed to the Copilot runtime. Strips the
 *  controller's Discord/discopilot secrets so a tool the agent runs cannot read
 *  them from its process env. (Defense-in-depth, not isolation — see PLAN §1.) */
export function sanitizeRuntimeEnv(
  base: NodeJS.ProcessEnv
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(DISCORD_|DISCOPILOT_)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface ClientOptions {
  /** Session working directory. Defaults to a neutral temp dir (self-check). */
  workingDirectory?: string;
}

/**
 * Central factory for the CopilotClient. Explicitly chooses a sanitized env and
 * working directory instead of inheriting the controller's. Uses the host's
 * logged-in Copilot, so `baseDirectory` is left at the default (~/.copilot),
 * where the login lives.
 */
export function createCopilotClient(opts: ClientOptions = {}): CopilotClient {
  return new CopilotClient({
    useLoggedInUser: true,
    logLevel: "error",
    env: sanitizeRuntimeEnv(process.env),
    workingDirectory: opts.workingDirectory ?? tmpdir(),
  });
}

export interface SelfCheckResult {
  installed: string;
  declared: string;
  modelCount: number;
  sample?: { id: string; contextWindow?: number; efforts?: string[] };
}

/** Connect to the local Copilot runtime and enumerate models. Proves the SDK
 *  wiring + local auth work end to end. Treats zero models as a failure. */
export async function sdkSelfCheck(): Promise<SelfCheckResult> {
  const client = createCopilotClient();
  await client.start();
  try {
    const models: ModelInfo[] = await client.listModels();
    if (models.length === 0) {
      throw new Error(
        "SDK self-check failed: listModels() returned 0 models (auth/policy problem?)."
      );
    }
    const m = models.find((x) => /sonnet|gpt/i.test(x.id)) ?? models[0];
    const sample = m
      ? {
          id: m.id,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens,
          efforts: m.supportedReasoningEfforts as string[] | undefined,
        }
      : undefined;
    return {
      installed: installedSdkVersion(),
      declared: declaredSdkVersion(),
      modelCount: models.length,
      ...(sample ? { sample } : {}),
    };
  } finally {
    await client.stop();
  }
}

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

/** SDK version discord-copilot-sdk declares — single source of truth is our own
 *  package.json dependency pin (no duplicated constant). */
export function declaredSdkVersion(): string {
  return (
    readPkgField(
      path.dirname(fileURLToPath(import.meta.url)),
      "discord-copilot-sdk",
      (p) => (p["dependencies"] as Record<string, string> | undefined)?.["@github/copilot-sdk"]
    ) ?? "unknown"
  );
}

export interface SdkCompat {
  installed: string;
  declared: string;
  ok: boolean;
}

/** Does the installed SDK match the version discord-copilot-sdk was built against? */
export function checkSdkCompat(): SdkCompat {
  const installed = installedSdkVersion();
  const declared = declaredSdkVersion();
  return { installed, declared, ok: installed === declared };
}

/** Build the sanitized environment handed to the Copilot runtime. Strips the
 *  controller's own secrets and settings so a tool the agent runs cannot read
 *  them from its process env. (Defense-in-depth, not isolation — see PLAN §1.)
 *
 *  `DISCORD_` covers both the bot token and this project's own
 *  `DISCORD_COPILOT_SDK_*` settings. `DISCOPILOT_` is the pre-rename prefix,
 *  kept deliberately: a variable left over from the old name in a shell profile
 *  or wrapper script must still never reach the agent. */
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

/**
 * Stop a Copilot client, treating a REPORTED failure as a failure.
 *
 * `CopilotClient.stop()` is `Promise<Error[]>`: it reports a cleanup that did
 * not work by FULFILLING with a non-empty array, not by rejecting. Awaiting it
 * for its side effect therefore read every one of those failures as a clean
 * stop — and in the bot that is what an armed teardown reports to the lifecycle
 * coordinator, which then released the single-instance lock over repos a
 * copilot-cli child might still have been working in. One place reads the
 * result, so no caller can drift back.
 */
export async function stopCopilotClient(client: Pick<CopilotClient, "stop">): Promise<void> {
  const errors = await client.stop();
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `the Copilot client reported ${errors.length} cleanup error(s) while stopping`
    );
  }
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
    // Audited alongside the two armed teardowns: this one REPORTS rather than
    // fails. `--selfcheck` owns no lock and holds no repo, and throwing from
    // this `finally` would replace the diagnostic the operator ran it for, so a
    // dirty stop is surfaced and the result stands.
    await stopCopilotClient(client).catch((err: unknown) => {
      console.error("selfcheck: the Copilot client did not stop cleanly", err);
    });
  }
}

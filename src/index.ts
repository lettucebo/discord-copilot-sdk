import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSingleInstanceLock } from "./core/single-instance.js";
import { lockPath, legacyStateDir, legacyNameWarnings } from "./core/paths.js";
import { formatVersionInfo, readAppVersion, readCommitSha } from "./core/version.js";
import { checkSdkCompat, sdkSelfCheck } from "./copilot/sdk.js";
import { loadConfig } from "./config.js";
import { DiscordCopilotApp } from "./app.js";

/** Load ./.env into process.env if present (Node built-in; no dependency). */
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  try {
    // process.loadEnvFile is available on Node >= 20.12 / 22.
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
  } catch {
    /* malformed/unreadable .env — ignore; config validation will surface it */
  }
}

/** Surface `discopilot`-era leftovers instead of silently misreading them. The
 *  old names are NOT honoured — see `legacyNameWarnings` for why — so the only
 *  responsible thing left is to say so out loud. */
function reportLegacyNames(): void {
  for (const line of legacyNameWarnings(process.env, existsSync(legacyStateDir()))) {
    console.warn(line);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = new Set(process.argv.slice(2));

  if (args.has("--version")) {
    const c = checkSdkCompat();
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(
      formatVersionInfo({ app: readAppVersion(repoRoot), commit: readCommitSha(repoRoot), sdk: c.installed }) +
        (c.ok ? "" : `  ⚠️ SDK declared ${c.declared}`)
    );
    return;
  }

  if (args.has("--selfcheck")) {
    reportLegacyNames();
    const lock = await acquireSingleInstanceLock(lockPath());
    try {
      const compat = checkSdkCompat();
      if (!compat.ok) {
        console.warn(
          `⚠️  installed SDK ${compat.installed} != declared ${compat.declared}`
        );
      }
      console.log(`Connecting to local Copilot via @github/copilot-sdk ${compat.installed} …`);
      const r = await sdkSelfCheck();
      console.log(`✅ SDK self-check OK — ${r.modelCount} models available`);
      if (r.sample) {
        console.log(
          `   sample: ${r.sample.id} • ctx=${r.sample.contextWindow ?? "?"} • efforts=${(r.sample.efforts ?? []).join("/") || "(none)"}`
        );
      }
    } finally {
      await lock.release();
    }
    return;
  }

  console.log("Starting discord-copilot-sdk bot …");
  reportLegacyNames();
  const config = loadConfig();
  await DiscordCopilotApp.start(config);
  // The Discord gateway connection keeps the event loop alive; shutdown is
  // handled by the app's SIGINT/SIGTERM handlers.
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

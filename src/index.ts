import { existsSync } from "node:fs";
import { acquireSingleInstanceLock } from "./core/single-instance.js";
import { lockPath } from "./core/paths.js";
import { checkSdkCompat, sdkSelfCheck } from "./copilot/sdk.js";

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

async function main(): Promise<void> {
  loadDotEnv();
  const args = new Set(process.argv.slice(2));

  if (args.has("--version")) {
    const c = checkSdkCompat();
    console.log(
      `discopilot • @github/copilot-sdk installed ${c.installed} (declared ${c.declared})` +
        (c.ok ? "" : "  ⚠️ mismatch")
    );
    return;
  }

  if (args.has("--selfcheck")) {
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

  console.log(
    "discopilot — the Discord bot is not implemented yet (P1).\n" +
      "  npm start -- --selfcheck   verify the local Copilot SDK wiring\n" +
      "  npm start -- --version     print installed/declared SDK versions"
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

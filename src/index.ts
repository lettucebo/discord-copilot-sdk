import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock } from "./core/single-instance.js";
import { checkSdkCompat, sdkSelfCheck } from "./copilot/sdk.js";

const LOCK_PATH = join(tmpdir(), "discopilot.lock");

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--version")) {
    const c = checkSdkCompat();
    console.log(`discopilot • @github/copilot-sdk ${c.installed} (expected ${c.expected})`);
    return;
  }

  if (args.has("--selfcheck")) {
    const lock = await acquireSingleInstanceLock(LOCK_PATH);
    try {
      const compat = checkSdkCompat();
      if (!compat.ok) {
        console.warn(`⚠️  installed SDK ${compat.installed} != expected ${compat.expected}`);
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
      "  npm start -- --version     print the installed SDK version"
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

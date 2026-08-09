#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LaunchError, launchDetached } from "./lib/run-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const result = await launchDetached({ root: ROOT, signal: controller.signal });
  console.log(`已啟動並已就緒 / Started and ready (PID ${result.pid}). Log: ${result.log}`);
  console.log(process.platform === "win32" ? "停止 / Stop: ./stop-bot.ps1" : "停止 / Stop: ./stop-bot.sh");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`啟動失敗 / Failed to start bot: ${message}`);
  if (error instanceof LaunchError && error.stderrTail) {
    console.error(`--- recent error log ---\n${error.stderrTail}`);
  }
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}

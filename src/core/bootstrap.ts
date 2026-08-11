import type { Config } from "../config.js";
import type { InstanceLock } from "./single-instance.js";

export interface StartedBot {
  stop(): Promise<void>;
}

export interface BotRuntime {
  loadConfig(): Config;
  start(config: Config, lock: InstanceLock): Promise<StartedBot>;
}

export interface StartBotOptions {
  acquireLock(): Promise<InstanceLock>;
  loadRuntime(): Promise<BotRuntime>;
  publishReady(): Promise<void>;
}

/**
 * Acquire ownership before loading the heavy runtime, then transfer it to the
 * app. Any startup failure releases the lock exactly through the owner-aware
 * release primitive, so a later launcher never inherits a live process's lock.
 */
export async function startBot({
  acquireLock,
  loadRuntime,
  publishReady,
}: StartBotOptions): Promise<void> {
  let lock: InstanceLock | undefined;
  let app: StartedBot | undefined;
  try {
    lock = await acquireLock();
    const runtime = await loadRuntime();
    app = await runtime.start(runtime.loadConfig(), lock);
    await publishReady();
  } catch (err) {
    if (app) await app.stop().catch(() => {});
    if (lock) await lock.release().catch(() => {});
    throw err;
  }
}

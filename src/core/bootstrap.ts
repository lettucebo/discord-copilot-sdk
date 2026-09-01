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
 * app.
 *
 * The transfer is what makes the `else` below load-bearing. Up to the moment
 * `runtime.start` returns, the lock is ours and a failure must release it, or a
 * later launcher inherits a lock no process holds. From that moment on it
 * belongs to the app, and `app.stop()` is the only thing entitled to decide
 * whether to give it up: it deliberately KEEPS the lock when it could not join
 * an in-flight access-retry attempt, because that attempt's already-issued
 * REST/git/runtime work cannot be recalled and a successor instance must not
 * start reconciling the same records and checkouts. Releasing it here as well
 * both double-released the normal path and silently undid that decision.
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
    else if (lock) await lock.release().catch(() => {});
    throw err;
  }
}

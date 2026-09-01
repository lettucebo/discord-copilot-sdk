import type { Config } from "../config.js";
import type { InstanceLock } from "./single-instance.js";

export interface StartedBot {
  stop(): Promise<void>;
}

export interface BotRuntime {
  loadConfig(): Config;
  /**
   * Take over the lock and start the bot.
   *
   * **Ownership transfers on INVOCATION, not on a successful return.** From the
   * moment this is called, the lock's fate is this function's responsibility in
   * every outcome: on success it belongs to the returned app, and on rejection
   * this function must already have dealt with it (by stopping the app it built,
   * which decides whether to release or deliberately keep the lock, or by
   * releasing it itself if there was no app). `startBot` therefore does not
   * touch the lock once it has called this, and a caller that breaks this
   * contract leaks a lock file no live process holds.
   */
  start(config: Config, lock: InstanceLock): Promise<StartedBot>;
}

export interface StartBotOptions {
  acquireLock(): Promise<InstanceLock>;
  loadRuntime(): Promise<BotRuntime>;
  publishReady(): Promise<void>;
}

/**
 * Acquire ownership before loading the heavy runtime, then transfer it to the
 * runtime.
 *
 * The transfer is the whole shape of the error handling below, and it happens
 * when `runtime.start` is CALLED — not when it returns. Before that call the
 * lock is ours and any failure must release it, or a later launcher inherits a
 * lock no process holds. From that call onwards it is the runtime's in every
 * outcome: a returned app decides its own fate in `app.stop()` (which
 * deliberately KEEPS the lock when it could not join an in-flight access-retry
 * attempt, because that attempt's already-issued REST/git/runtime work cannot be
 * recalled), and a rejection means the runtime has already stopped whatever it
 * built and dealt with the lock itself. Releasing here in either of those cases
 * double-released the normal path and silently undid the deliberate hold.
 */
export async function startBot({
  acquireLock,
  loadRuntime,
  publishReady,
}: StartBotOptions): Promise<void> {
  let lock: InstanceLock | undefined;
  let app: StartedBot | undefined;
  // Set BEFORE the await, not after it: a rejection must still count as
  // transferred, because `runtime.start` owns its own cleanup.
  let transferred = false;
  try {
    lock = await acquireLock();
    const runtime = await loadRuntime();
    const config = runtime.loadConfig();
    transferred = true;
    app = await runtime.start(config, lock);
    await publishReady();
  } catch (err) {
    if (app) await app.stop().catch(() => {});
    else if (!transferred && lock) await lock.release().catch(() => {});
    throw err;
  }
}

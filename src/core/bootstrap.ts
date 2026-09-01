import type { Config } from "../config.js";
import { createLifecycleOwnership, type LifecycleOwnership } from "./lifecycle-ownership.js";
import type { InstanceLock } from "./single-instance.js";

export interface StartedBot {
  stop(): Promise<void>;
}

export interface BotRuntime {
  loadConfig(): Config;
  /**
   * Take over ownership and start the bot.
   *
   * It is handed the SAME `LifecycleOwnership` the lock was given to, not the
   * lock. That is the contract in one line: from here on exactly one object
   * decides when this process lets go, and this function's job is to arm it with
   * the teardown for whatever it builds. Every failure — here or in
   * `publishReady` — is answered by `ownership.shutdown()`, which is idempotent,
   * so there is no longer a "whose release is it" question to get wrong.
   */
  start(config: Config, ownership: LifecycleOwnership): Promise<StartedBot>;
}

export interface StartBotOptions {
  acquireLock(): Promise<InstanceLock>;
  loadRuntime(): Promise<BotRuntime>;
  publishReady(): Promise<void>;
}

/**
 * Acquire the lock, wrap it in the one thing allowed to release it, and start.
 *
 * There is deliberately no `transferred` flag, no `if (app)` and no
 * `lock.release()` here any more. Those existed because ownership moved between
 * bootstrap and the app at a moment that was hard to name — before the call?
 * after a successful return? — and every answer was wrong for some failure. The
 * coordinator is created the instant the lock exists and is the only holder from
 * then on; bootstrap's entire responsibility on failure is to tell it to shut
 * down.
 */
export async function startBot({
  acquireLock,
  loadRuntime,
  publishReady,
}: StartBotOptions): Promise<void> {
  let ownership: LifecycleOwnership | undefined;
  let app: StartedBot | undefined;
  try {
    ownership = createLifecycleOwnership(await acquireLock());
    const runtime = await loadRuntime();
    app = await runtime.start(runtime.loadConfig(), ownership);
    await publishReady();
  } catch (err) {
    // Once the app exists, `app.stop()` is the door — not the coordinator.
    // `stop()` closes the phase gate SYNCHRONOUSLY before shutdown begins, so no
    // command is admitted while the teardown runs; going straight to the
    // coordinator would tear the app down underneath a bot that still believed
    // it was ready. Before the app exists there is nothing to gate and the
    // coordinator is the only thing that can answer.
    if (app) await app.stop().catch(() => {});
    else if (ownership) await ownership.shutdown().catch(() => {});
    throw err;
  }
}

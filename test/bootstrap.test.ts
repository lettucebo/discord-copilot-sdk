import { describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { startBot } from "../src/core/bootstrap.js";
import type { LifecycleOwnership } from "../src/core/lifecycle-ownership.js";
import type { InstanceLock } from "../src/core/single-instance.js";

function config(): Config {
  return parseConfig({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_ALLOWED_USER_IDS: "123456789",
    DISCORD_GUILD_ID: "123456789",
    DISCORD_PARENT_CHANNEL_ID: "987654321",
    REPOS_ROOT: "C:\\repos",
  });
}

function lock(release = vi.fn(async () => {})): InstanceLock {
  return { path: "test.lock", release };
}

/**
 * Bootstrap no longer decides anything about the lock, so these test the ONE
 * thing it still owes: every failure reaches the coordinator, and the
 * coordinator's answer is the only answer.
 */
describe("startBot", () => {
  it("acquires the instance lock before loading the heavy runtime", async () => {
    const events: string[] = [];
    const release = vi.fn(async () => {});

    await startBot({
      acquireLock: async () => {
        events.push("lock");
        return lock(release);
      },
      loadRuntime: async () => {
        events.push("runtime");
        return {
          loadConfig: () => config(),
          start: async (_c: Config, ownership: LifecycleOwnership) => {
            events.push("start");
            ownership.arm(async () => void events.push("teardown"));
            return { stop: async () => {} };
          },
        };
      },
      publishReady: async () => {
        events.push("ready");
      },
    });

    expect(events).toEqual(["lock", "runtime", "start", "ready"]);
    expect(release).not.toHaveBeenCalled(); // a running bot keeps its lock
  });

  it("tears down through app.stop, not the coordinator, when readiness cannot be published", async () => {
    // `app.stop()` closes the phase gate synchronously before shutdown begins.
    // Reaching for the coordinator instead would tear the app down underneath a
    // bot that still believed it was ready and was still admitting commands.
    const release = vi.fn(async () => {});
    const order: string[] = [];
    const teardown = vi.fn(async () => void order.push("teardown"));
    const stop = vi.fn(async () => {
      order.push("app.stop");
    });

    await expect(
      startBot({
        acquireLock: async () => lock(release),
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async (_c: Config, ownership: LifecycleOwnership) => {
            ownership.arm(teardown);
            return {
              stop: async () => {
                await stop();
                await ownership.shutdown();
              },
            };
          },
        }),
        publishReady: async () => {
          throw new Error("marker write denied");
        },
      })
    ).rejects.toThrow(/marker write denied/);

    expect(stop).toHaveBeenCalledOnce();
    expect(order).toEqual(["app.stop", "teardown"]); // the gate closes FIRST
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not release while the armed teardown reports an outstanding obligation", async () => {
    // The reason the coordinator exists: the app discovers, while tearing down,
    // that something it started is not provably finished. Bootstrap cannot know
    // that and must not decide anything on its behalf.
    const release = vi.fn(async () => {});

    await expect(
      startBot({
        acquireLock: async () => lock(release),
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async (_c: Config, ownership: LifecycleOwnership) => {
            ownership.arm(async (scope) => {
              scope.retain("wedged-runtime", {
                describe: () => "a runtime that never confirmed it stopped",
                attempt: async () => false,
              });
            });
            return { stop: () => ownership.shutdown() };
          },
        }),
        publishReady: async () => {
          throw new Error("marker write denied");
        },
      })
    ).rejects.toThrow(/marker write denied/);

    expect(release).not.toHaveBeenCalled();
  });

  it("shuts down through the coordinator when runtime.start rejects after arming", async () => {
    const release = vi.fn(async () => {});
    const teardown = vi.fn(async () => {});

    await expect(
      startBot({
        acquireLock: async () => lock(release),
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async (_c: Config, ownership: LifecycleOwnership) => {
            ownership.arm(teardown);
            throw new Error("gateway login failed");
          },
        }),
        publishReady: async () => {},
      })
    ).rejects.toThrow(/gateway login failed/);

    expect(teardown).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce(); // once, never twice
  });

  it("releases when runtime.start rejects before it armed anything", async () => {
    const release = vi.fn(async () => {});

    await expect(
      startBot({
        acquireLock: async () => lock(release),
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async () => {
            throw new Error("SDK version mismatch");
          },
        }),
        publishReady: async () => {},
      })
    ).rejects.toThrow(/SDK version mismatch/);

    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the early lock when runtime loading fails", async () => {
    const release = vi.fn(async () => {});

    await expect(
      startBot({
        acquireLock: async () => lock(release),
        loadRuntime: async () => {
          throw new Error("runtime import failed");
        },
        publishReady: async () => {},
      })
    ).rejects.toThrow(/runtime import failed/);

    expect(release).toHaveBeenCalledOnce();
  });

  it("has nothing to release when the lock itself could not be acquired", async () => {
    await expect(
      startBot({
        acquireLock: async () => {
          throw new Error("another instance is already running");
        },
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async () => ({ stop: async () => {} }),
        }),
        publishReady: async () => {},
      })
    ).rejects.toThrow(/another instance is already running/);
  });
});

import { describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { startBot } from "../src/core/bootstrap.js";
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

describe("startBot", () => {
  it("acquires the instance lock before loading the heavy runtime", async () => {
    const events: string[] = [];
    const held = lock();

    await startBot({
      acquireLock: async () => {
        events.push("lock");
        return held;
      },
      loadRuntime: async () => {
        events.push("runtime");
        return {
          loadConfig: () => config(),
          start: async () => {
            events.push("start");
            return { stop: async () => {} };
          },
        };
      },
      publishReady: async () => {
        events.push("ready");
      },
    });

    expect(events).toEqual(["lock", "runtime", "start", "ready"]);
    expect(held.release).not.toHaveBeenCalled();
  });

  it("stops a fully-started app and releases its lock when readiness cannot be published", async () => {
    const release = vi.fn(async () => {});
    const stop = vi.fn(async () => {});

    await expect(
      startBot({
        acquireLock: async () => lock(release),
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async () => ({ stop }),
        }),
        publishReady: async () => {
          throw new Error("marker write denied");
        },
      })
    ).rejects.toThrow(/marker write denied/);

    expect(stop).toHaveBeenCalledOnce();
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
});

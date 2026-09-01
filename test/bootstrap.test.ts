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

  it("stops a fully-started app and lets IT release the lock when readiness cannot be published", async () => {
    const release = vi.fn(async () => {});
    const held = lock(release);
    // The real `DiscordCopilotApp.start` hands the lock to the app, and
    // `app.stop()` is what releases it — through its own rules. Modelling that
    // here is the point: bootstrap must not release it a second time.
    const stop = vi.fn(async () => {
      await held.release();
    });

    await expect(
      startBot({
        acquireLock: async () => held,
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

  it("does NOT release a lock a stopped app deliberately still holds", async () => {
    // `app.stop()` keeps the lock when it could not join an in-flight
    // access-retry attempt: that attempt's already-issued REST/git/runtime work
    // cannot be recalled, and a successor instance must not start reconciling
    // the same records. Bootstrap releasing it behind the app's back would undo
    // exactly that protection — the app owns the lock from the moment it is
    // handed over, including the decision to keep holding it.
    const release = vi.fn(async () => {});
    const held = lock(release);
    const stop = vi.fn(async () => {
      /* deliberately retains the lock */
    });

    await expect(
      startBot({
        acquireLock: async () => held,
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
    expect(release).not.toHaveBeenCalled();
  });

  it("does not release when runtime.start rejects after doing its own cleanup", async () => {
    // Ownership transfers when `runtime.start` is INVOKED, not when it returns:
    // `DiscordCopilotApp.start` takes the lock, and its own failure path either
    // stops the app it built (which decides the lock's fate) or releases the
    // lock itself. Bootstrap releasing again on a rejection is a second release
    // of a lock it no longer owns.
    const release = vi.fn(async () => {});
    const held = lock(release);

    await expect(
      startBot({
        acquireLock: async () => held,
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async () => {
            // What the real `start()` does when it got far enough to build an
            // app: stop it, and let the app decide about the lock.
            await held.release();
            throw new Error("gateway login failed");
          },
        }),
        publishReady: async () => {},
      })
    ).rejects.toThrow(/gateway login failed/);

    expect(release).toHaveBeenCalledOnce();
  });

  it("does not release when runtime.start rejects while deliberately holding the lock", async () => {
    const release = vi.fn(async () => {});

    await expect(
      startBot({
        acquireLock: async () => lock(release),
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: async () => {
            throw new Error("stopped, but an in-flight attempt still holds the lock");
          },
        }),
        publishReady: async () => {},
      })
    ).rejects.toThrow(/still holds the lock/);

    expect(release).not.toHaveBeenCalled();
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

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The app's durable state lives under the home directory. Redirect it before
// anything imports a module that resolves it, so this suite never reads the
// registry of whoever runs it.
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const fakeHome = mkdtempSync(join(tmpdir(), "dp-start-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

/**
 * The SDK module is mocked so the two earliest production failures are
 * reachable WITHOUT a real Copilot runtime, and so the test can prove the
 * runtime was never reached at all.
 */
const { sdk } = vi.hoisted(() => ({
  sdk: {
    compat: { ok: true, installed: "1.0.0", declared: "1.0.0" } as {
      ok: boolean;
      installed: string;
      declared: string;
    },
    clientsCreated: 0,
    clientStartError: undefined as string | undefined,
    clientStops: 0,
    clientStopErrors: [] as Error[],
    clientStartBlocks: undefined as Promise<void> | undefined,

  },
}));
vi.mock("../src/copilot/sdk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/copilot/sdk.js")>();
  return {
    checkSdkCompat: () => sdk.compat,
    createCopilotClient: () => {
      sdk.clientsCreated++;
      return {
        start: async () => {
          if (sdk.clientStartError) throw new Error(sdk.clientStartError);
        },
        // The real contract: `stop()` FULFILS with the errors it hit, so a
        // clean stop is an empty array.
        stop: async (): Promise<Error[]> => {
          sdk.clientStops++;
          return sdk.clientStopErrors;
        },
        listModels: async () => [],
      };
    },
    sdkSelfCheck: async () => ({ modelCount: 0 }),
    // Deliberately NOT stubbed: mocking the reported-error check away would make
    // these ownership tests green against a helper that does not exist.
    stopCopilotClient: actual.stopCopilotClient,
  };
});

const { DiscordCopilotApp, StartupAbandonedError } = await import("../src/app.js");
const { parseConfig } = await import("../src/config.js");
import type { InstanceLock } from "../src/core/single-instance.js";
import { createLifecycleOwnership } from "../src/core/lifecycle-ownership.js";

/** Bootstrap wraps the lock in the coordinator before start ever sees it; the
 *  release assertions below are unchanged, because the coordinator releases the
 *  same lock. */
const own = (held: { lock: InstanceLock }): ReturnType<typeof createLifecycleOwnership> =>
  createLifecycleOwnership(held.lock);

const reposRoot = mkdtempSync(join(tmpdir(), "dp-start-repos-"));

function config(over: Record<string, string> = {}): ReturnType<typeof parseConfig> {
  return parseConfig({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_ALLOWED_USER_IDS: "123456789",
    DISCORD_GUILD_ID: "123456789",
    DISCORD_PARENT_CHANNEL_ID: "987654321",
    REPOS_ROOT: reposRoot,
    ...over,
  });
}

function lock(): { lock: InstanceLock; releases: () => number } {
  let releases = 0;
  return {
    lock: {
      path: join(fakeHome, "test.lock"),
      release: async () => {
        releases++;
      },
    },
    releases: () => releases,
  };
}

afterEach(() => {
  sdk.compat = { ok: true, installed: "1.0.0", declared: "1.0.0" };
  sdk.clientsCreated = 0;
  sdk.clientStartError = undefined;
  sdk.clientStops = 0;
  sdk.clientStopErrors = [];
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(reposRoot, { recursive: true, force: true });
});

/**
 * These drive the REAL `DiscordCopilotApp.start`, not a fake `BotRuntime`.
 *
 * `startBot` transfers the lock the moment it CALLS `runtime.start`, so every
 * way out of the real `start()` has to account for it. A fake runtime can only
 * prove that bootstrap keeps its side of that contract; only the real function
 * can prove it keeps its own — and the failures that used to escape it (a bad
 * `REPOS_ROOT`, an SDK version mismatch) were thrown from ABOVE its try block,
 * where its catch could not see them.
 */
describe("DiscordCopilotApp.start owns the lock from the moment it is called", () => {
  it("releases the lock when REPOS_ROOT is rejected, before any runtime exists", async () => {
    const held = lock();

    await expect(
      DiscordCopilotApp.start(config({ REPOS_ROOT: join(reposRoot, "does-not-exist") }), own(held))
    ).rejects.toThrow(/REPOS_ROOT does not exist/);

    expect(held.releases()).toBe(1);
    expect(sdk.clientsCreated).toBe(0); // no Copilot, and therefore no Discord
  });

  it("releases the lock when REPOS_ROOT would contain the bot's own state directory", async () => {
    const held = lock();

    await expect(DiscordCopilotApp.start(config({ REPOS_ROOT: fakeHome }), own(held))).rejects.toThrow(
      /state directory|worktree directory/
    );

    expect(held.releases()).toBe(1);
    expect(sdk.clientsCreated).toBe(0);
  });

  it("releases the lock on an SDK version mismatch", async () => {
    sdk.compat = { ok: false, installed: "9.9.9", declared: "1.0.0" };
    const held = lock();

    await expect(DiscordCopilotApp.start(config(), own(held))).rejects.toThrow(
      /Installed @github\/copilot-sdk 9\.9\.9 != declared 1\.0\.0/
    );

    expect(held.releases()).toBe(1);
    expect(sdk.clientsCreated).toBe(0); // the check gates the client, not vice versa
  });

  it("stops the runtime AND releases the lock when the runtime fails to start", async () => {
    // The failure that already lived inside the try. Kept here so a future
    // reshuffle cannot fix the early throws by breaking this one.
    sdk.clientStartError = "copilot runtime unavailable";
    const held = lock();

    await expect(DiscordCopilotApp.start(config(), own(held))).rejects.toThrow(
      /copilot runtime unavailable/
    );

    expect(sdk.clientsCreated).toBe(1);
    expect(sdk.clientStops).toBe(1); // the client it created is torn down
    expect(held.releases()).toBe(1);
  });

  it("never releases the lock twice on any of these paths", async () => {
    // One release per failure, not two: `stop()` may deliberately RETAIN the
    // lock, and a second release from anywhere would undo that.
    const cases: Array<() => Promise<unknown>> = [];
    const locks: Array<{ lock: InstanceLock; releases: () => number }> = [];
    for (const build of [
      () => DiscordCopilotApp.start(config({ REPOS_ROOT: join(reposRoot, "nope") }), own(locks[0]!)),
      () => DiscordCopilotApp.start(config(), own(locks[1]!)),
    ]) {
      locks.push(lock());
      cases.push(build);
    }
    sdk.clientStartError = undefined;

    await expect(cases[0]!()).rejects.toThrow();
    expect(locks[0]!.releases()).toBe(1);

    sdk.compat = { ok: false, installed: "2.0.0", declared: "1.0.0" };
    await expect(cases[1]!()).rejects.toThrow();
    expect(locks[1]!.releases()).toBe(1);
  });
});

describe("start()'s repos root fixture", () => {
  it("is a usable root, so the failures above are the ones under test", () => {
    mkdirSync(join(reposRoot, "placeholder"), { recursive: true });
    expect(() => config()).not.toThrow();
  });
});

describe("startup torn down between construction and login", () => {
  it("rejects with StartupAbandonedError, never returns an app, releases once", async () => {
    // The exact schedule: the app EXISTS (so a failure must go through its own
    // `stop()`, closing the phase gate) but the gateway is not up yet. A quiet
    // return here used to let `start()` resolve and `startBot` publish
    // readiness for a process that had been torn down.
    const held = lock();
    const { createLifecycleOwnership } = await import("../src/core/lifecycle-ownership.js");
    const ownership = createLifecycleOwnership(held.lock, { joinTimeoutMs: 20 });

    let seenPhase: string | undefined;
    const starting = DiscordCopilotApp.start(config(), ownership, {
      beforeLogin: async (app) => {
        // A SIGTERM arrives here.
        await app.stop();
        seenPhase = (app as unknown as { phase: string }).phase;
      },
    });

    await expect(starting).rejects.toThrow(StartupAbandonedError);
    expect(seenPhase).toBe("shuttingDown"); // the gate closed synchronously
    expect(sdk.clientsCreated).toBe(1);
    expect(sdk.clientStops).toBe(1); // the client it built was put down
    await vi.waitFor(() => expect(held.releases()).toBe(1)); // exactly once
  });

  // `startBot` builds its own coordinator with production bounds, so the join of
  // the still-open startup scope really does take the default 5s here.
  it("never publishes readiness for a startup that was torn down", { timeout: 20_000 }, async () => {
    let published = 0;
    const { startBot } = await import("../src/core/bootstrap.js");
    const release = vi.fn(async () => {});

    await expect(
      startBot({
        acquireLock: async () => ({ path: "(test)", release }),
        loadRuntime: async () => ({
          loadConfig: () => config(),
          start: (c, ownership) =>
            DiscordCopilotApp.start(c, ownership, {
              beforeLogin: async (app) => {
                await app.stop();
              },
            }),
        }),
        publishReady: async () => {
          published++;
        },
        retractReady: async () => {},
      })
    ).rejects.toThrow(StartupAbandonedError);

    expect(published).toBe(0); // the readiness marker is never written
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("an armed teardown the SDK REPORTS as failed", () => {
  it("keeps the lock when copilot.stop() fulfils with cleanup errors", async () => {
    // End to end through the REAL `start()` and the REAL armed teardown. The
    // client reports a dirty stop by FULFILLING with errors; awaiting it for the
    // side effect read that as success, so the coordinator concluded everything
    // was down and released the single-instance lock while a copilot-cli child
    // was still running.
    const held = lock();
    const ownership = createLifecycleOwnership(held.lock, { joinTimeoutMs: 20 });
    sdk.clientStopErrors = [new Error("copilot-cli child did not exit")];

    const starting = DiscordCopilotApp.start(config(), ownership, {
      beforeLogin: async (app) => {
        await app.stop().catch(() => {});
      },
    });

    await expect(starting).rejects.toThrow();
    expect(sdk.clientStops).toBe(1);
    // The teardown could not be proved, so the lock is still this process's.
    await new Promise((r) => setTimeout(r, 40));
    expect(held.releases()).toBe(0);
  });
});

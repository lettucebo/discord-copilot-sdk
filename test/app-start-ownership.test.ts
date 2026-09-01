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
    clientStartBlocks: undefined as Promise<void> | undefined,

  },
}));
vi.mock("../src/copilot/sdk.js", () => ({
  checkSdkCompat: () => sdk.compat,
  createCopilotClient: () => {
    sdk.clientsCreated++;
    return {
      start: async () => {
        if (sdk.clientStartError) throw new Error(sdk.clientStartError);
      },
      stop: async () => {
        sdk.clientStops++;
      },
      listModels: async () => [],
    };
  },
  sdkSelfCheck: async () => ({ modelCount: 0 }),
}));

const { DiscordCopilotApp } = await import("../src/app.js");
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

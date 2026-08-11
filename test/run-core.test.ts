import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  inspectLock,
  inspectReadyMarker,
  launchDetached,
  makeLaunchToken,
  startupReadyMarkerPath,
} from "../scripts/lib/run-core.mjs";

const directories: string[] = [];
const spawnedPids: number[] = [];

function fixtureRoot(source: string): { root: string; state: string } {
  const root = mkdtempSync(path.join(tmpdir(), "dcs-run-core-"));
  const state = path.join(root, "state");
  directories.push(root);
  const dist = path.join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "index.js"), source, "utf8");
  return { root, state };
}

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(25);
  }
}

async function waitForFile(file: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (existsSync(file)) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${file}`);
}

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* child already exited */
    }
    await waitForExit(pid);
  }
  for (const dir of directories.splice(0)) {
    let removed = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(dir, { force: true, recursive: true, maxRetries: 2, retryDelay: 25 });
        removed = true;
        break;
      } catch (error) {
        if (attempt === 49) throw error;
        await sleep(100);
      }
    }
    expect(removed).toBe(true);
  }
});

describe("detached launcher core", () => {
  it("uses an unguessable 256-bit hexadecimal launch token", () => {
    const token = makeLaunchToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on an indeterminate lock and rejects marker identity mismatches", () => {
    const { state } = fixtureRoot("");
    const lock = path.join(state, "default.lock");
    mkdirSync(state, { recursive: true });
    writeFileSync(lock, "not-a-pid", "utf8");
    expect(inspectLock(lock)).toEqual({ kind: "indeterminate" });

    const marker = startupReadyMarkerPath(state, "default", "b".repeat(64));
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ version: 1, pid: 77, instance: "other" }), "utf8");
    expect(inspectReadyMarker(marker, "default", 77)).toEqual({ kind: "invalid" });
  });

  function delayedReadySource(delay = 250): string {
    return [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const state = process.env.TEST_STATE;',
      'const instance = process.env.DISCORD_COPILOT_SDK_INSTANCE_ID || "default";',
      'const token = process.env.DISCORD_COPILOT_SDK_STARTUP_READY_TOKEN;',
      "fs.mkdirSync(path.join(state, 'startup-ready'), { recursive: true });",
      `setTimeout(() => {`,
      "  const lock = path.join(state, `${instance}.lock`);",
      "  if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8').trim() === '99999999') fs.rmSync(lock);",
      "  try {",
      "    const fd = fs.openSync(lock, 'wx');",
      "    fs.writeFileSync(fd, String(process.pid));",
      "    fs.closeSync(fd);",
      "  } catch {",
      "    process.exit(8);",
      "  }",
      "  fs.writeFileSync(path.join(state, 'startup-ready', `${instance}.${token}.json`), JSON.stringify({ version: 1, pid: process.pid, instance }));",
      `}, ${delay});`,
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n");
  }

  it("waits for matching lock and ready proof rather than a short process-survival check", async () => {
    const { root, state } = fixtureRoot(delayedReadySource());
    const result = await launchDetached({
      root,
      stateDir: state,
      timeoutMs: 5_000,
      pollMs: 20,
      env: { ...process.env, TEST_STATE: state, DISCORD_COPILOT_SDK_INSTANCE_ID: "test" },
    });

    expect(result.instance).toBe("test");
    expect(inspectLock(path.join(state, "test.lock"))).toEqual({ kind: "live", pid: result.pid });
    expect(existsSync(path.join(state, "startup-ready"))).toBe(true);
    expect(readdirSync(path.join(state, "startup-ready"))).toEqual([]);

    spawnedPids.push(result.pid);
    process.kill(result.pid, "SIGKILL");
    await waitForExit(result.pid);
  });

  it("allows only one concurrent launcher to become ready after a stale lock", async () => {
    const { root, state } = fixtureRoot(delayedReadySource(150));
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, "test.lock"), "99999999", "utf8");
    const env = { ...process.env, TEST_STATE: state, DISCORD_COPILOT_SDK_INSTANCE_ID: "test" };
    const [first, second] = await Promise.allSettled([
      launchDetached({ root, stateDir: state, timeoutMs: 5_000, pollMs: 20, env }),
      launchDetached({ root, stateDir: state, timeoutMs: 5_000, pollMs: 20, env }),
    ]);

    const ready = [first, second].filter(
      (
        result
      ): result is PromiseFulfilledResult<{ pid: number; instance: string; log: string; errorLog: string }> =>
        result.status === "fulfilled"
    );
    const failed = [first, second].filter((result) => result.status === "rejected");
    expect(ready).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // Both losers are fail-closed. Depending on which child removes the stale
    // lock last, the loser either exits before readiness or publishes a marker
    // after another child has acquired the lock.
    expect(String(failed[0]?.reason)).toMatch(
      /exited before ready|published ready without owning its instance lock/i
    );

    const pid = ready[0]?.value.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) throw new Error("expected one ready child");
    spawnedPids.push(pid);
  });

  it("reports a child that exits after the old two-second probe but before ready", async () => {
    const { root, state } = fixtureRoot("setTimeout(() => process.exit(9), 2_100);\n");

    await expect(
      launchDetached({
        root,
        stateDir: state,
        timeoutMs: 5_000,
        pollMs: 20,
      })
    ).rejects.toThrow(/exited before ready/i);
  }, 10_000);

  it("terminates only its own child when readiness times out", async () => {
    const source = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const state = process.env.TEST_STATE;',
      "fs.mkdirSync(state, { recursive: true });",
      "fs.writeFileSync(path.join(state, 'child.pid'), String(process.pid));",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n");
    const { root, state } = fixtureRoot(source);

    await expect(
      launchDetached({
        root,
        stateDir: state,
        timeoutMs: 1_000,
        pollMs: 20,
        env: { ...process.env, TEST_STATE: state },
      })
    ).rejects.toThrow(/timed out/i);

    const childPid = Number(readFileSync(path.join(state, "child.pid"), "utf8"));
    await waitForExit(childPid);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("terminates its own child when the waiting launcher is interrupted", async () => {
    const source = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const state = process.env.TEST_STATE;',
      "fs.mkdirSync(state, { recursive: true });",
      "fs.writeFileSync(path.join(state, 'child.pid'), String(process.pid));",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n");
    const { root, state } = fixtureRoot(source);
    const controller = new AbortController();
    const launching = launchDetached({
      root,
      stateDir: state,
      timeoutMs: 5_000,
      pollMs: 20,
      signal: controller.signal,
      env: { ...process.env, TEST_STATE: state },
    });
    const childFile = path.join(state, "child.pid");
    await waitForFile(childFile);
    controller.abort();

    await expect(launching).rejects.toThrow(/cancelled/i);
    const childPid = Number(readFileSync(childFile, "utf8"));
    await waitForExit(childPid);
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});

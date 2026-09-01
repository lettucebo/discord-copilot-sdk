import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  STARTUP_READY_TOKEN_ENV,
  clearStartupReady,
  publishStartupReady,
  retractStartupReady,
  startupReadyMarkerPath,
  startupReadyRequest,
  startupReadyStatusPath,
} from "../src/core/startup-ready.js";
import {
  inspectReadyMarker,
  startupReadyMarkerPath as launcherMarkerPath,
} from "../scripts/lib/run-core.mjs";

const token = "a".repeat(64);
const directories: string[] = [];

function directory(): string {
  const made = mkdtempSync(path.join(tmpdir(), "dcs-startup-ready-"));
  directories.push(made);
  return made;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("startup readiness request", () => {
  it("treats an unset token as a direct or foreground start", () => {
    expect(startupReadyRequest({})).toBeUndefined();
  });

  it("fails closed when a launcher token is malformed", () => {
    expect(() => startupReadyRequest({ [STARTUP_READY_TOKEN_ENV]: "not-a-token" })).toThrow(/launch token/i);
  });

  it("publishes only the matching PID and instance in an atomic marker", async () => {
    const dir = directory();
    const readyDir = path.join(dir, "startup-ready");
    const request = startupReadyRequest({ [STARTUP_READY_TOKEN_ENV]: token });
    await publishStartupReady(request, { directory: readyDir, instance: "test", pid: 4242 });

    const marker = startupReadyMarkerPath("test", token, readyDir);
    expect(launcherMarkerPath(dir, "test", token)).toBe(marker);
    expect(inspectReadyMarker(marker, "test", 4242)).toEqual({ kind: "ready" });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      version: 1,
      pid: 4242,
      instance: "test",
    });
    expect(path.basename(marker)).not.toContain("tmp");
    expect(JSON.parse(readFileSync(startupReadyStatusPath("test", readyDir), "utf8"))).toEqual({
      version: 1,
      pid: 4242,
      instance: "test",
    });
  });

  it("refuses to overwrite a readiness proof for the same one-time token", async () => {
    const dir = directory();
    const readyDir = path.join(dir, "startup-ready");
    const marker = startupReadyMarkerPath("test", token, readyDir);
    mkdirSync(readyDir, { recursive: true });
    writeFileSync(marker, "{}", "utf8");

    await expect(
      publishStartupReady({ token }, { directory: readyDir, instance: "test", pid: 4242 })
    ).rejects.toThrow(/already exists/i);
  });

  it("removes current readiness only when the shutdown PID still owns it", async () => {
    const dir = directory();
    const readyDir = path.join(dir, "startup-ready");
    await publishStartupReady({ token }, { directory: readyDir, instance: "test", pid: 4242 });
    const status = startupReadyStatusPath("test", readyDir);

    await clearStartupReady("test", 4243, readyDir);
    expect(JSON.parse(readFileSync(status, "utf8")).pid).toBe(4242);

    await clearStartupReady("test", 4242, readyDir);
    expect(() => readFileSync(status, "utf8")).toThrow();
  });
});


describe("retractStartupReady (a publication this process must not have made)", () => {
  it("removes BOTH the status and the request-token marker", async () => {
    // `publishStartupReady` writes two files: the current-ready status AND the
    // token marker the launcher polls. `clearStartupReady` only ever removed the
    // first, so a retraction left the token marker behind — and the launcher
    // consumes exactly that, reporting a successful start for a process that had
    // already abandoned its startup.
    const stateDir = directory();
    const dir = path.join(stateDir, "startup-ready");
    const request = { token };
    await publishStartupReady(request, { directory: dir, instance: "default", pid: 4321 });
    const status = startupReadyStatusPath("default", dir);
    const marker = startupReadyMarkerPath("default", token, dir);
    expect(readFileSync(status, "utf8")).toContain("4321");
    // The launcher sees a successful start — this is what it polls.
    expect(inspectReadyMarker(launcherMarkerPath(stateDir, "default", token), "default", 4321)).toEqual({
      kind: "ready",
    });

    await retractStartupReady(request, { directory: dir, instance: "default", pid: 4321 });

    expect(existsSync(status)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // …and now it does NOT report a success for a bot that abandoned startup.
    expect(inspectReadyMarker(launcherMarkerPath(stateDir, "default", token), "default", 4321)).toEqual({
      kind: "absent",
    });
  });

  it("refuses to delete a SUCCESSOR's markers", async () => {
    // The retraction runs while a successor may already own the lock and have
    // published its own readiness. Deleting either of its files would make the
    // launcher wait for a bot that is in fact serving.
    const dir = directory();
    const request = { token };
    await publishStartupReady(request, { directory: dir, instance: "default", pid: 5555 });

    await retractStartupReady(request, { directory: dir, instance: "default", pid: 4321 });

    expect(existsSync(startupReadyStatusPath("default", dir))).toBe(true);
    expect(existsSync(startupReadyMarkerPath("default", token, dir))).toBe(true);
  });

  it("removes the status alone when there was no launcher request", async () => {
    const dir = directory();
    await publishStartupReady(undefined, { directory: dir, instance: "default", pid: 4321 });

    await retractStartupReady(undefined, { directory: dir, instance: "default", pid: 4321 });

    expect(existsSync(startupReadyStatusPath("default", dir))).toBe(false);
  });

  it("leaves a DIFFERENT instance alone", async () => {
    const dir = directory();
    await publishStartupReady({ token }, { directory: dir, instance: "other", pid: 4321 });

    await retractStartupReady({ token }, { directory: dir, instance: "default", pid: 4321 });

    expect(existsSync(startupReadyStatusPath("other", dir))).toBe(true);
    expect(existsSync(startupReadyMarkerPath("other", token, dir))).toBe(true);
  });
});
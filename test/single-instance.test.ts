import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { acquireSingleInstanceLock } from "../src/core/single-instance.js";

const lockPath = join(tmpdir(), `discord-copilot-sdk-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`);

afterEach(() => {
  try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
});

describe("acquireSingleInstanceLock", () => {
  it("acquires when free and writes the pid; release removes the file", async () => {
    const lock = await acquireSingleInstanceLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses when a live instance (different pid) holds the lock", async () => {
    writeFileSync(lockPath, "424242", "utf8"); // a different, (pretended) live pid
    await expect(acquireSingleInstanceLock(lockPath, () => true)).rejects.toThrow(/already running/i);
  });

  it("reclaims a stale lock left by a dead process", async () => {
    writeFileSync(lockPath, "999999999", "utf8"); // pid that isn't alive
    const lock = await acquireSingleInstanceLock(lockPath, () => false);
    expect(existsSync(lockPath)).toBe(true);
    await lock.release();
  });

  it("fails closed when the lock file is empty/indeterminate (never reclaims a possibly-live lock)", async () => {
    writeFileSync(lockPath, "", "utf8"); // empty ⇒ owner indeterminate
    await expect(acquireSingleInstanceLock(lockPath, () => true)).rejects.toThrow(/indeterminate|fail-closed/i);
    expect(existsSync(lockPath)).toBe(true); // must NOT have reclaimed/removed it
  });

  it("release does not delete a lock now owned by a successor", async () => {
    const lock = await acquireSingleInstanceLock(lockPath);
    writeFileSync(lockPath, "424242", "utf8"); // a successor overwrote ownership
    await lock.release();
    expect(existsSync(lockPath)).toBe(true); // our release must not remove it
  });
});

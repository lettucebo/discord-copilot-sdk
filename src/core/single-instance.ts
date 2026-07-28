import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** A held single-instance lock. Call `release()` on shutdown. */
export interface InstanceLock {
  readonly path: string;
  release(): Promise<void>;
}

/** True if a process with `pid` is currently running on this host. */
function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire an exclusive single-instance lock backed by a PID lock file.
 *
 * Fails (throws) when another *live* instance already holds the lock — two
 * overlapping processes would invalidate every process-local atomicity
 * assumption in the broker/session layer, so we refuse to start. A lock left by
 * a dead process (crash) is treated as stale and reclaimed.
 *
 * Safety: the pid is created+written synchronously so the lock file is never
 * observable as empty by a racing process. If a reader still finds the holder
 * indeterminate (empty/unreadable — e.g. a crash mid-create, or corruption), it
 * **fails closed** (treats the holder as live and refuses) rather than
 * reclaiming a possibly-live lock. `isAlive` is injectable for tests.
 */
export async function acquireSingleInstanceLock(
  lockPath: string,
  isAlive: (pid: number) => boolean = defaultIsAlive
): Promise<InstanceLock> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreateLock(lockPath)) {
      return { path: lockPath, release: () => releaseIfOwner(lockPath) };
    }

    // Lock file already exists — decide whether we may reclaim it.
    const holder = await readHolderPidWithRetry(lockPath);
    if (holder === undefined) {
      throw new Error(
        `A discord-copilot-sdk lock exists at ${lockPath} but its owner is indeterminate ` +
          `(empty/unreadable). Refusing to start (fail-closed). If you are sure no ` +
          `instance is running, delete the lock file and retry.`
      );
    }
    if (holder !== process.pid && isAlive(holder)) {
      throw new Error(
        `Another discord-copilot-sdk instance is already running (pid ${holder}, lock ${lockPath}). Refusing to start.`
      );
    }
    // Stale (dead holder) or ours (pid reuse after a crash) — reclaim and retry.
    removeQuietlySync(lockPath);
  }
  throw new Error(`Could not acquire single-instance lock at ${lockPath}`);
}

/** Atomically create the lock and write our pid in one synchronous sequence so
 *  the file is never observable empty. Returns false on EEXIST. */
function tryCreateLock(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx"); // exclusive create; throws EEXIST if present
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Read the holder pid, retrying briefly to ride out the microscopic window
 *  between a well-behaved writer's create and write. Returns undefined only when
 *  the file stays empty/unreadable across all attempts. */
async function readHolderPidWithRetry(lockPath: string): Promise<number | undefined> {
  for (let i = 0; i < 4; i++) {
    const pid = readHolderPid(lockPath);
    if (pid !== undefined) return pid;
    await sleep(30);
  }
  return undefined;
}

function readHolderPid(lockPath: string): number | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function removeQuietlySync(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

async function releaseIfOwner(lockPath: string): Promise<void> {
  // Only remove the lock if it still belongs to us. If it was reclaimed by a
  // successor (e.g. we were mistakenly considered dead), we must NOT delete the
  // successor's lock.
  if (readHolderPid(lockPath) !== process.pid) return;
  try {
    await unlink(lockPath);
  } catch {
    /* already gone */
  }
}

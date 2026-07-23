import { open, readFile, unlink } from "node:fs/promises";

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
 * `isAlive` is injectable for tests.
 */
export async function acquireSingleInstanceLock(
  lockPath: string,
  isAlive: (pid: number) => boolean = defaultIsAlive
): Promise<InstanceLock> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" => create exclusively; fails with EEXIST if the file is present.
      const fh = await open(lockPath, "wx");
      try {
        await fh.writeFile(String(process.pid), "utf8");
      } finally {
        await fh.close();
      }
      return { path: lockPath, release: () => releaseQuietly(lockPath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const holder = await readHolderPid(lockPath);
      if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
        throw new Error(
          `Another discopilot instance is already running (pid ${holder}, lock ${lockPath}). Refusing to start.`
        );
      }
      // Stale (or ours): remove and retry once.
      await releaseQuietly(lockPath);
    }
  }
  throw new Error(`Could not acquire single-instance lock at ${lockPath}`);
}

async function readHolderPid(lockPath: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function releaseQuietly(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    /* already gone */
  }
}

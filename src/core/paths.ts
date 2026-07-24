import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Logical instance identity. Multiple intentional deployments on one host use
 * distinct ids (e.g. DISCOPILOT_INSTANCE_ID=work). Ownership is defined by this
 * id, NOT by the (mutable) installation path. Defaults to "default".
 */
export function instanceId(): string {
  const raw = (process.env.DISCOPILOT_INSTANCE_ID ?? "default").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : "default";
}

/** Stable per-user application state directory (created on demand). Unlike
 *  os.tmpdir(), this is not swept by temp cleaners while the bot runs. */
export function stateDir(): string {
  const dir = path.join(os.homedir(), ".discopilot");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to the single-instance lock file for a logical instance. */
export function lockPath(id: string = instanceId()): string {
  return path.join(stateDir(), `${id}.lock`);
}

/** Path to the persisted session store for a logical instance (P2 resume). */
export function sessionStorePath(id: string = instanceId()): string {
  return path.join(stateDir(), `${id}.session.json`);
}

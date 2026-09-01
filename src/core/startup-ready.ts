import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { instanceId, stateDir } from "./paths.js";

/** Environment variable set only by the detached launcher for one startup. */
export const STARTUP_READY_TOKEN_ENV = "DISCORD_COPILOT_SDK_STARTUP_READY_TOKEN";

const TOKEN_RE = /^[a-f0-9]{64}$/;

export interface StartupReadyRequest {
  readonly token: string;
}

export interface StartupReadyMarker {
  readonly version: 1;
  readonly pid: number;
  readonly instance: string;
}

/**
 * Parse a detached launcher's one-time readiness request.
 *
 * An unset variable means foreground, residency, or a direct Node invocation.
 * A present-but-invalid variable is fatal: treating it as absent would let a
 * launcher wait for a marker this process will never publish.
 */
export function startupReadyRequest(
  env: NodeJS.ProcessEnv = process.env
): StartupReadyRequest | undefined {
  const token = env[STARTUP_READY_TOKEN_ENV];
  if (token === undefined) return undefined;
  if (!TOKEN_RE.test(token)) {
    throw new Error(
      `${STARTUP_READY_TOKEN_ENV} must be a 64-character lowercase hexadecimal launch token.`
    );
  }
  return { token };
}

/** Directory intentionally separate from PID locks: markers prove one launch completed. */
export function startupReadyDirectory(): string {
  return path.join(stateDir(), "startup-ready");
}

export function startupReadyMarkerPath(
  instance: string,
  token: string,
  directory: string = startupReadyDirectory()
): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(instance)) {
    throw new Error(`Invalid startup-ready instance id: ${instance}`);
  }
  if (!TOKEN_RE.test(token)) {
    throw new Error("Invalid startup-ready launch token.");
  }
  return path.join(directory, `${instance}.${token}.json`);
}

/** Current readiness is not ownership: readers must still prove the PID owns the lock. */
export function startupReadyStatusPath(
  instance: string,
  directory: string = startupReadyDirectory()
): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(instance)) {
    throw new Error(`Invalid startup-ready instance id: ${instance}`);
  }
  return path.join(directory, `${instance}.ready.json`);
}

export interface PublishStartupReadyOptions {
  instance?: string;
  directory?: string;
  pid?: number;
}

async function writeMarker(marker: string, content: StartupReadyMarker, replace: boolean): Promise<void> {
  const temp = `${marker}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(content)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    // Token markers must never be overwritten. The current-ready status is
    // intentionally replaced by a successor only after that successor reached
    // ready, so a live older instance cannot masquerade as the new one.
    if (!replace && existsSync(marker)) {
      throw new Error(`Startup-ready marker already exists: ${marker}`);
    }
    await rename(temp, marker);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Atomically publish proof that all startup work completed.
 *
 * The PID lock remains the sole ownership record. This short-lived marker only
 * lets the launcher distinguish "the process exists" from "Discord is ready".
 */
export async function publishStartupReady(
  request: StartupReadyRequest | undefined = startupReadyRequest(),
  options: PublishStartupReadyOptions = {}
): Promise<void> {
  const instance = options.instance ?? instanceId();
  const dir = options.directory ?? startupReadyDirectory();
  const pid = options.pid ?? process.pid;
  mkdirSync(dir, { recursive: true });
  const content: StartupReadyMarker = { version: 1, pid, instance };
  await writeMarker(startupReadyStatusPath(instance, dir), content, true);
  if (request) {
    await writeMarker(startupReadyMarkerPath(instance, request.token, dir), content, false);
  }
}

/** Remove only this process's current-ready proof during graceful shutdown. */
export async function clearStartupReady(
  instance: string = instanceId(),
  pid: number = process.pid,
  directory: string = startupReadyDirectory()
): Promise<void> {
  await removeOwnedMarker(startupReadyStatusPath(instance, directory), instance, pid);
}

/**
 * Take back a readiness publication this process must not have made.
 *
 * `publishStartupReady` writes TWO files: the current-ready status, and — when a
 * launcher supplied a token — the marker that launcher polls. `clearStartupReady`
 * removes only the first, which is right for a graceful shutdown of a bot that
 * really did serve: the launcher has long since consumed its token marker.
 *
 * A RETRACTION is different. The publication is being withdrawn because the
 * process abandoned its startup, and the launcher is very likely still polling.
 * Leaving the token marker there reports a successful start for a bot that is
 * going away. Both files are removed, and both are removed OWNER-SAFELY: a
 * successor may already hold the lock and have published its own readiness, and
 * deleting its files would make the launcher wait for a bot that is in fact
 * serving.
 */
export async function retractStartupReady(
  request: StartupReadyRequest | undefined = startupReadyRequest(),
  options: PublishStartupReadyOptions = {}
): Promise<void> {
  const instance = options.instance ?? instanceId();
  const dir = options.directory ?? startupReadyDirectory();
  const pid = options.pid ?? process.pid;
  await removeOwnedMarker(startupReadyStatusPath(instance, dir), instance, pid);
  if (request) {
    await removeOwnedMarker(startupReadyMarkerPath(instance, request.token, dir), instance, pid);
  }
}

/** Delete `marker` only when it names THIS process and instance. A file we did
 *  not write is a successor's, and it is not ours to remove. */
async function removeOwnedMarker(marker: string, instance: string, pid: number): Promise<void> {
  let parsed: StartupReadyMarker;
  try {
    parsed = JSON.parse(readFileSync(marker, "utf8")) as StartupReadyMarker;
  } catch {
    return;
  }
  if (parsed.version === 1 && parsed.pid === pid && parsed.instance === instance) {
    await rm(marker, { force: true });
  }
}

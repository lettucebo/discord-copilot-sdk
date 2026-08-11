// Detached launcher core. The app PID lock remains the single ownership truth;
// this module only waits for a one-time proof that startup reached Discord ready.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

export const STARTUP_READY_TOKEN_ENV = "DISCORD_COPILOT_SDK_STARTUP_READY_TOKEN";
export const STARTUP_TIMEOUT_MS = 120_000;
export const STARTUP_POLL_MS = 100;
export const STARTUP_READY_VERSION = 1;

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;

export class LaunchError extends Error {
  constructor(message, stderrTail = "") {
    super(message);
    this.name = "LaunchError";
    this.stderrTail = stderrTail;
  }
}

export function instanceId(env = process.env) {
  const raw = (env.DISCORD_COPILOT_SDK_INSTANCE_ID ?? "").trim();
  return INSTANCE_RE.test(raw) ? raw : "default";
}

export function stateDirectory(home = os.homedir()) {
  return path.join(home, ".discord-copilot-sdk");
}

export function startupReadyMarkerPath(stateDir, instance, token) {
  if (!INSTANCE_RE.test(instance)) throw new Error(`invalid instance id: ${instance}`);
  if (!TOKEN_RE.test(token)) throw new Error("invalid launch token");
  return path.join(stateDir, "startup-ready", `${instance}.${token}.json`);
}

export function makeLaunchToken(random = randomBytes) {
  return random(32).toString("hex");
}

export function isLivePid(pid, killFn = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Read the app's sole PID lock without accepting a partial/ambiguous owner.
 * A malformed lock must not be silently bypassed by a new detached child.
 */
export function inspectLock(lockPath, fsMod = fs, killFn = process.kill.bind(process)) {
  if (!fsMod.existsSync(lockPath)) return { kind: "absent" };
  let raw;
  try {
    raw = fsMod.readFileSync(lockPath, "utf8").trim();
  } catch {
    return { kind: "indeterminate" };
  }
  if (!/^\d+$/.test(raw)) return { kind: "indeterminate" };
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 1) return { kind: "indeterminate" };
  return isLivePid(pid, killFn) ? { kind: "live", pid } : { kind: "stale", pid };
}

export function inspectReadyMarker(markerPath, instance, pid, fsMod = fs) {
  if (!fsMod.existsSync(markerPath)) return { kind: "absent" };
  let parsed;
  try {
    parsed = JSON.parse(fsMod.readFileSync(markerPath, "utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.version !== STARTUP_READY_VERSION ||
    parsed.pid !== pid ||
    parsed.instance !== instance
  ) {
    return { kind: "invalid" };
  }
  return { kind: "ready" };
}

export function tailSince(file, offset, fsMod = fs, maxBytes = 8_000) {
  try {
    const data = fsMod.readFileSync(file);
    const start = Math.max(offset, data.length - maxBytes);
    return data.subarray(start).toString("utf8").trim();
  } catch {
    return "";
  }
}

/** Bound stale artifact cleanup without touching an in-progress 120-second launch. */
export function removeExpiredReadyMarkers(
  directory,
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1_000,
  fsMod = fs
) {
  try {
    for (const entry of fsMod.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Za-z0-9._-]{1,64}\.[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const marker = path.join(directory, entry.name);
      if (now - fsMod.statSync(marker).mtimeMs > maxAgeMs) fsMod.rmSync(marker, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exited(child, terminal) {
  return terminal.value || child.exitCode !== null && child.exitCode !== undefined;
}

async function terminateChild(child, terminal, wait = sleep) {
  if (!child.pid || exited(child, terminal)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  const softDeadline = Date.now() + 5_000;
  while (!exited(child, terminal) && Date.now() < softDeadline) {
    await wait(50);
  }
  if (exited(child, terminal)) return;

  // This remains scoped to the exact child the launcher created. On Windows,
  // Node maps signals to process termination; on POSIX this bounds a hung
  // shutdown that never reached the app's SIGTERM handler.
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited between the check and the signal.
  }
}

function closeQuietly(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    /* closed already */
  }
}

/**
 * Spawn one detached bot process and return only after that exact PID owns the
 * app lock and has published its ready proof. This deliberately does not infer
 * readiness from log text or mere process existence.
 *
 * @param {{
 *   root?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stateDir?: string,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   spawnFn?: typeof spawn,
 *   now?: () => number,
 *   wait?: (ms: number) => Promise<void>,
 *   killFn?: (pid: number, signal?: number | NodeJS.Signals) => void,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{pid: number, instance: string, log: string, errorLog: string}>}
 */
export async function launchDetached({
  root,
  env = process.env,
  stateDir = stateDirectory(),
  timeoutMs = STARTUP_TIMEOUT_MS,
  pollMs = STARTUP_POLL_MS,
  spawnFn = spawn,
  now = Date.now,
  wait = sleep,
  killFn = process.kill.bind(process),
  signal,
} = {}) {
  if (!root || !path.isAbsolute(root)) throw new Error("root must be an absolute path");
  const instance = instanceId(env);
  const lock = path.join(stateDir, `${instance}.lock`);
  const prior = inspectLock(lock, fs, killFn);
  if (prior.kind === "live") {
    throw new LaunchError(`Already running (PID ${prior.pid}). Run the stop script first.`);
  }
  if (prior.kind === "indeterminate") {
    throw new LaunchError(`Cannot start: app lock is unreadable: ${lock}`);
  }

  const readyDirectory = path.join(stateDir, "startup-ready");
  fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
  fs.mkdirSync(readyDirectory, { recursive: true });
  removeExpiredReadyMarkers(readyDirectory, now());

  const token = makeLaunchToken();
  const marker = startupReadyMarkerPath(stateDir, instance, token);
  fs.rmSync(marker, { force: true });
  const log = path.join(stateDir, "logs", `run-bot.${instance}.log`);
  const errorLog = `${log}.err`;
  let errorOffset = 0;
  try {
    errorOffset = fs.statSync(errorLog).size;
  } catch {
    // The file is created below if this is the first detached launch.
  }

  const outputFd = fs.openSync(log, "a");
  const errorFd = fs.openSync(errorLog, "a");
  let child;
  const terminal = { value: false, description: "" };
  try {
    child = spawnFn(process.execPath, ["dist/index.js"], {
      cwd: root,
      detached: true,
      env: { ...env, [STARTUP_READY_TOKEN_ENV]: token },
      stdio: ["ignore", outputFd, errorFd],
      windowsHide: true,
    });
    const childPid = child.pid;
    if (!Number.isSafeInteger(childPid) || childPid <= 1) {
      throw new LaunchError("Detached bot process did not expose a valid PID.");
    }
    child.once("exit", (code, signal) => {
      terminal.value = true;
      terminal.description = `process exited before ready (code ${code ?? "none"}, signal ${signal ?? "none"})`;
    });
    child.once("error", (error) => {
      terminal.value = true;
      terminal.description = `process could not start: ${error.message}`;
    });
    child.unref();

    const deadline = now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) {
        throw new LaunchError("Startup cancelled before bot readiness.");
      }
      if (exited(child, terminal)) {
        throw new LaunchError(
          `Bot ${terminal.description || "exited before ready"}.`,
          tailSince(errorLog, errorOffset)
        );
      }

      const ready = inspectReadyMarker(marker, instance, childPid);
      if (ready.kind === "invalid") {
        throw new LaunchError("Bot published an invalid startup-ready marker.");
      }
      if (ready.kind === "ready") {
        const owner = inspectLock(lock, fs, killFn);
        if (owner.kind === "live" && owner.pid === childPid) {
          return { pid: childPid, instance, log, errorLog };
        }
        throw new LaunchError("Bot published ready without owning its instance lock.");
      }

      if (now() >= deadline) {
        throw new LaunchError(`Timed out after ${Math.ceil(timeoutMs / 1_000)} seconds waiting for bot readiness.`);
      }
      await wait(Math.min(pollMs, deadline - now()));
    }
  } catch (error) {
    if (child) await terminateChild(child, terminal, wait);
    if (error instanceof LaunchError) throw error;
    throw new LaunchError(
      error instanceof Error ? error.message : String(error),
      tailSince(errorLog, errorOffset)
    );
  } finally {
    fs.rmSync(marker, { force: true });
    closeQuietly(outputFd);
    closeQuietly(errorFd);
  }
}

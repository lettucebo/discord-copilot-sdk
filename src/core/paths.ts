import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

/** The state directory this project used before it was renamed from
 *  `discopilot`. Exported so the startup check and the docs can't drift apart. */
export const LEGACY_STATE_DIR_NAME = ".discopilot";

/** Name of the per-user state directory. A single constant because
 *  `worktreeRoot()` is derived from it by suffix — spelling the literal twice is
 *  how the worktree root would silently stop being the state dir's sibling. */
export const STATE_DIR_NAME = ".discord-copilot-sdk";

/** The environment prefix this project used before it was renamed. Still
 *  stripped from the agent's environment (see `sanitizeRuntimeEnv`), but NOT
 *  honoured as configuration. */
export const LEGACY_ENV_PREFIX = "DISCOPILOT_";

/**
 * Logical instance identity. Multiple intentional deployments on one host use
 * distinct ids (e.g. DISCORD_COPILOT_SDK_INSTANCE_ID=work). Ownership is defined by this
 * id, NOT by the (mutable) installation path. Defaults to "default".
 */
export function instanceId(): string {
  const raw = (process.env.DISCORD_COPILOT_SDK_INSTANCE_ID ?? "default").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : "default";
}

/** Stable per-user application state directory (created on demand). Unlike
 *  os.tmpdir(), this is not swept by temp cleaners while the bot runs. */
export function stateDir(): string {
  const dir = path.join(os.homedir(), STATE_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where a pre-rename install kept its state. Never read — only reported. */
export function legacyStateDir(): string {
  return path.join(os.homedir(), LEGACY_STATE_DIR_NAME);
}

/**
 * Where per-session worktrees live.
 *
 * Deliberately NOT under `stateDir()`: that directory holds `approvals.json`,
 * the session store and the instance lock, and every agent's cwd would then sit
 * two levels below the bot's own trust store. In a threat model where the
 * controlled repo is untrusted and tools run unsandboxed as the OS user, one
 * approved relative-path write would be enough to grant durable auto-approval
 * for arbitrary executables. Keeping worktrees in a sibling directory means no
 * agent's working directory has the trust store as an ancestor.
 *
 * It lives HERE rather than in `app.ts` because it is now half of a security
 * boundary that four separate places must agree on — `resolveReposRoot`'s
 * disjointness check, `validateBinding`, the stray-worktree scan and the
 * uninstaller. A private copy in the orchestrator is how two of them would
 * quietly come to disagree about where the boundary is.
 *
 * NOTE: unlike `stateDir()` this does NOT create the directory. It is asked for
 * by validators that must be able to run before any worktree exists, and
 * creating it as a side effect of *checking a path* would leave an empty
 * directory behind on every rejected config.
 */
export function worktreeRoot(): string {
  return `${path.join(os.homedir(), STATE_DIR_NAME)}-worktrees`;
}

/**
 * Warnings about `discopilot`-era leftovers found on this host.
 *
 * These are deliberately warnings and NOT fallbacks. Honouring the old env
 * prefix would create a permanent second configuration surface for a name that
 * no longer exists, and silently adopting the old state directory would restore
 * saved "Always (this repo)" approval grants the operator may have forgotten —
 * the one direction this project never moves in. Losing a grant is the fail-safe
 * outcome; the resumable session record is the part worth telling them about, so
 * they can move it across on purpose.
 *
 * Pure (takes the environment and the directory's existence) so it is testable
 * without touching the real home directory.
 */
export function legacyNameWarnings(
  env: NodeJS.ProcessEnv,
  legacyStateDirExists: boolean
): string[] {
  const out: string[] = [];
  if (legacyStateDirExists) {
    out.push(
      `⚠️  Found a pre-rename state directory at ~/${LEGACY_STATE_DIR_NAME} — it is NOT read. ` +
        `This project now uses ~/.discord-copilot-sdk. If it holds a session you still want to ` +
        `resume, move *.session.json across; saved approval rules are deliberately not restored ` +
        `for you, so re-grant them from Discord if you still want them.`
    );
  }
  const legacy = Object.keys(env).filter((k) =>
    k.toUpperCase().startsWith(LEGACY_ENV_PREFIX)
  );
  if (legacy.length) {
    out.push(
      `⚠️  Ignoring pre-rename environment variable(s): ${legacy.join(", ")}. ` +
        `Rename the prefix to DISCORD_COPILOT_SDK_ (e.g. DISCORD_COPILOT_SDK_INSTANCE_ID). ` +
        `They are still stripped from the agent's environment, but they configure nothing.`
    );
  }
  return out;
}

/** Path to the single-instance lock file for a logical instance. */
export function lockPath(id: string = instanceId()): string {
  return path.join(stateDir(), `${id}.lock`);
}

/** Path to the persisted session store for a logical instance (P2 resume). */
export function sessionStorePath(id: string = instanceId()): string {
  return path.join(stateDir(), `${id}.session.json`);
}

/** Path to the enabled-channel registry for a logical instance. Per-instance
 *  like the lock and the session store, because a second instance is a second
 *  bot with its own guild/channel configuration. */
export function channelRegistryPath(id: string = instanceId()): string {
  return path.join(stateDir(), `${id}.channels.json`);
}

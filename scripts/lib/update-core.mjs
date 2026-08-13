// Pure update planning helpers. The updater must decide whether it is safe to
// stop the bot before it changes HEAD, so this module has no filesystem or
// subprocess side effects and is covered independently.

/** @typedef {"managed" | "branch-clean" | "branch-dirty" | "unknown"} CheckoutKind */

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Read this application's release version from already-read package metadata.
 *
 * The network updater downloads this pure module alongside its engine, so the
 * parser cannot rely on a built `dist/` directory or filesystem access.
 *
 * @param {string} jsonText
 * @returns {string}
 */
export function parsePackageVersion(jsonText) {
  try {
    const pkg = JSON.parse(jsonText);
    const version = typeof pkg === "object" && pkg !== null ? pkg.version : undefined;
    if (
      typeof pkg !== "object" ||
      pkg === null ||
      pkg.name !== "discord-copilot-sdk" ||
      typeof version !== "string" ||
      !SEMVER.test(version)
    ) {
      return "unknown";
    }
    return version;
  } catch {
    return "unknown";
  }
}

/**
 * Classify a checkout from the two facts collected by git before any mutation.
 *
 * A detached, clean checkout is bootstrap-managed: get.ps1/get.sh deliberately
 * detach every clone they manage. A named branch may update only when clean, so
 * the caller can prove a fast-forward is possible before it stops the bot.
 *
 * @param {{symbolicRef: string | null, status: string | null}} facts
 * @returns {CheckoutKind}
 */
export function classifyCheckout({ symbolicRef, status }) {
  if (typeof symbolicRef !== "string" || typeof status !== "string") return "unknown";
  if (symbolicRef === "") return status.trim() === "" ? "managed" : "unknown";
  return status.trim() === "" ? "branch-clean" : "branch-dirty";
}

/**
 * Parse the machine-readable records returned by `git ls-remote`.
 *
 * @param {string} output
 * @returns {{sha: string, ref: string}[]}
 */
export function parseLsRemote(output) {
  if (typeof output !== "string") return [];
  const records = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9A-Za-z]+)\t(refs\/(?:heads|tags)\/[^\s^]+(?:\^\{\})?)$/.exec(line);
    if (match) records.push({ sha: match[1], ref: match[2] });
  }
  return records;
}

/**
 * Resolve a requested branch or tag to the commit git will check out.
 *
 * Short names prefer branches, matching the installer's default `main` branch.
 * A fully-qualified ref removes that ambiguity. Annotated tags have an object
 * record plus a peeled `^{}` commit record; HEAD points at the latter, so it
 * must win or `--check` would falsely report an update forever.
 *
 * @param {{sha: string, ref: string}[]} records
 * @param {string} requestedRef
 * @returns {{sha: string, ref: string} | null}
 */
export function resolveRemoteSha(records, requestedRef) {
  if (!Array.isArray(records) || typeof requestedRef !== "string" || requestedRef === "") return null;

  const find = (ref) => records.find((record) => record.ref === ref) ?? null;
  if (requestedRef.startsWith("refs/heads/")) return find(requestedRef);
  if (requestedRef.startsWith("refs/tags/")) {
    return find(`${requestedRef}^{}`) ?? find(requestedRef);
  }

  return find(`refs/heads/${requestedRef}`) ?? find(`refs/tags/${requestedRef}^{}`) ?? find(`refs/tags/${requestedRef}`);
}

/**
 * Expand a requested ref to the exact remote refs needed to resolve it.
 *
 * @param {string} requestedRef
 * @returns {string[]}
 */
export function remoteRefSpecs(requestedRef) {
  if (typeof requestedRef !== "string" || requestedRef === "") return [];
  if (requestedRef.startsWith("refs/heads/")) return [requestedRef];
  if (requestedRef.startsWith("refs/tags/")) return [requestedRef, `${requestedRef}^{}`];
  if (requestedRef.startsWith("refs/")) return [];
  return [`refs/heads/${requestedRef}`, `refs/tags/${requestedRef}`, `refs/tags/${requestedRef}^{}`];
}

/**
 * Decide whether an updater may move on from its read-only preflight.
 *
 * @param {{
 *   checkout: CheckoutKind,
 *   localSha: string,
 *   remoteSha: string | null,
 *   runningInstances: readonly string[],
 *   allInstances: boolean,
 *   pendingRestore?: boolean,
 *   mode?: "check" | "dry-run"
 * }} input
 * @returns {{action: "refuse", reason: string} | {action: "up-to-date" | "check" | "dry-run" | "apply"}}
 */
export function planUpdate({ checkout, localSha, remoteSha, runningInstances, allInstances, pendingRestore, mode }) {
  if (pendingRestore && mode === undefined) return { action: "refuse", reason: "pending-restore" };
  if (checkout !== "managed" && checkout !== "branch-clean") return { action: "refuse", reason: checkout };
  if (typeof remoteSha !== "string" || remoteSha === "") return { action: "refuse", reason: "remote-not-found" };
  if (Array.isArray(runningInstances) && runningInstances.length > 1 && !allInstances) {
    return { action: "refuse", reason: "other-instances-running" };
  }
  if (localSha === remoteSha) return { action: "up-to-date" };
  if (mode === "check") return { action: "check" };
  if (mode === "dry-run") return { action: "dry-run" };
  return { action: "apply" };
}

/**
 * Parse update CLI arguments without reading environment or touching the repo.
 *
 * @param {string[]} args
 * @returns {{
 *   check: boolean,
 *   dryRun: boolean,
 *   yes: boolean,
 *   noRestart: boolean,
 *   allInstances: boolean,
 *   restore: boolean,
 *   ref: string | undefined,
 *   lang: "zh" | "en" | undefined,
 *   error: string | null
 * }}
 */
export function parseUpdateArgs(args) {
  const result = {
    check: false,
    dryRun: false,
    yes: false,
    noRestart: false,
    allInstances: false,
    restore: false,
    ref: undefined,
    lang: undefined,
    error: null,
  };
  if (!Array.isArray(args)) return { ...result, error: "invalid-args" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--check":
        result.check = true;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--yes":
      case "-y":
        result.yes = true;
        break;
      case "--no-restart":
        result.noRestart = true;
        break;
      case "--all-instances":
        result.allInstances = true;
        break;
      case "--restore":
        result.restore = true;
        break;
      case "--ref": {
        const value = args[++i];
        if (typeof value !== "string" || value === "" || value.startsWith("-")) return { ...result, error: "missing-ref" };
        result.ref = value;
        break;
      }
      case "--lang": {
        const value = args[++i];
        if (value !== "zh" && value !== "en") return { ...result, error: "invalid-lang" };
        result.lang = value;
        break;
      }
      default:
        return { ...result, error: "unknown-flag" };
    }
  }

  if (result.check && result.dryRun) return { ...result, error: "check-and-dry-run-conflict" };
  if (result.restore && (result.check || result.dryRun)) return { ...result, error: "restore-with-read-only-mode" };
  return result;
}

/** A namespace distinct from `<instance>.lock`, which only the bot may own. */
export function updateLockRelativePath(instance) {
  return `updates/${instance}.lock`;
}

/**
 * A successor PID is just as unsafe as the PID present before stop. This keeps
 * a lifecycle wait from missing a launchd/systemd respawn between two polls.
 *
 * @param {{instance: string, pid?: number}[]} live
 * @param {readonly string[]} targets
 */
export function targetInstancesStopped(live, targets) {
  const targetSet = new Set(targets);
  return !live.some((entry) => targetSet.has(entry.instance));
}

/**
 * A ready marker is evidence only when it names the same live lock PID. The
 * app lock remains ownership authority; a forced Windows stop can leave an old
 * marker behind, which must never make updater recovery look healthy.
 *
 * @param {string} text
 * @param {string} instance
 * @param {number} pid
 */
export function readyMarkerMatches(text, instance, pid) {
  try {
    const marker = JSON.parse(text);
    return (
      marker !== null &&
      typeof marker === "object" &&
      marker.version === 1 &&
      marker.instance === instance &&
      marker.pid === pid
    );
  } catch {
    return false;
  }
}

/** A restore snapshot exists until the whole update flow finishes cleanly. */
export function shouldRetainRestoreState(updateCompleted) {
  return !updateCompleted;
}

/** The apply sequence. Residency must stop before the process it restarts. */
export const UPDATE_STEPS = ["residency", "process", "source", "setup"];

/**
 * Return update steps in their safety-critical order.
 *
 * @param {string[]} steps
 * @returns {string[]}
 */
export function orderUpdateSteps(steps) {
  const rank = new Map(UPDATE_STEPS.map((step, index) => [step, index]));
  return [...steps].sort((a, b) => (rank.get(a) ?? UPDATE_STEPS.length) - (rank.get(b) ?? UPDATE_STEPS.length));
}

// Pure update planning helpers. The updater must decide whether it is safe to
// stop the bot before it changes HEAD, so this module has no filesystem or
// subprocess side effects and is covered independently.

/** @typedef {"managed" | "branch-clean" | "branch-dirty" | "unknown"} CheckoutKind */

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

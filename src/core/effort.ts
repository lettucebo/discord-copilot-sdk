/**
 * Pure reasoning-effort validation for /model and /effort.
 *
 * Three-state contract for `supported` (the model's supportedReasoningEfforts):
 *  - `undefined` → the model was NOT in the snapshot (listModels failed, or the
 *    id is unknown). We cannot validate, so we stay lenient and let the runtime
 *    be the final authority.
 *  - `[]` → a KNOWN model that supports no reasoning effort at all (per the SDK,
 *    `supportedReasoningEfforts` is "only present if the model supports reasoning
 *    effort"; we normalize absent → `[]` at load time).
 *  - non-empty → the exact set of supported effort levels.
 *
 * Collapsing `[]` and `undefined` (the pre-fix bug) let an unsupported effort
 * ride along to a non-reasoning model, which the SDK expects the host to reject.
 */

/** When switching TO a model, decide whether the currently-set effort must be
 *  dropped. Only drops for a KNOWN model that doesn't list the current effort;
 *  an unknown model (undefined) leaves the effort untouched. */
export function shouldResetEffort(
  currentEffort: string | undefined,
  supported: string[] | undefined
): boolean {
  if (!currentEffort) return false;
  if (supported === undefined) return false; // unknown model → can't judge
  return !supported.includes(currentEffort);
}

export type EffortValidation = { ok: true } | { ok: false; message: string };

/** Validate a requested effort `level` against the current model's supported
 *  set. Unknown model (undefined) → allowed (lenient). Known-but-empty → the
 *  model has no reasoning effort. Known non-empty → must include the level. */
export function validateEffort(
  model: string | undefined,
  level: string,
  supported: string[] | undefined
): EffortValidation {
  if (supported === undefined) return { ok: true }; // unknown → let runtime decide
  if (supported.includes(level)) return { ok: true };
  const label = model ? `\`${model}\`` : "此模型";
  const message = supported.length
    ? `Model ${label} 支援的 effort：${supported.join(", ")}。`
    : `Model ${label} 不支援 reasoning effort（無法設定 effort）。`;
  return { ok: false, message };
}

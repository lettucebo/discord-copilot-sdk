import { deriveThreadTitle, THREAD_NAME_MAX } from "./thread-name.js";

/** How much of the user's first prompt is forwarded to the titler. A very long
 *  first message is exactly the case this feature exists for, and the titler
 *  only needs the gist — sending 50 KB would be slow and pointless. */
export const TITLE_INPUT_MAX = 2000;

/** Cheapest-first models to title with. The titler runs once per session on a
 *  ~30-token prompt, but it should still never land on an expensive or
 *  reasoning-heavy model just because it was first in the tenant's list.
 *  Verified present in a live `listModels()` snapshot (2026-07-28). */
export const TITLE_MODEL_PREFERENCE = [
  "gemini-3.5-flash",
  "claude-haiku-4.5",
  "gpt-5-mini",
  "gpt-5.4-mini",
] as const;

/** Choose the model to title with. Returns undefined when none of the preferred
 *  models is available, so the caller falls back to the local heuristic rather
 *  than running the titler on an arbitrary (possibly expensive) model. */
export function pickTitleModel(available: readonly string[], override?: string): string | undefined {
  const set = new Set(available);
  if (override && set.has(override)) return override;
  return TITLE_MODEL_PREFERENCE.find((m) => set.has(m));
}

/** The titling instruction. Kept explicit about length and formatting because
 *  small models otherwise answer with `Title: "..."` or a whole paragraph. */
export function buildTitlePrompt(firstMessage: string): string {
  const body = firstMessage.slice(0, TITLE_INPUT_MAX);
  return (
    "Write a short title for the following request, for use as a chat thread name.\n" +
    "Rules: at most 6 words (or ~20 characters for Chinese/Japanese/Korean); " +
    "same language as the request; no quotes, no markdown, no trailing period, " +
    "no prefix such as 'Title:'. Reply with the title ONLY.\n\n" +
    "REQUEST:\n" +
    body
  );
}

/** Normalise a small model's reply into a thread title. Returns "" for junk so
 *  the caller can fall back to the local heuristic. */
export function cleanModelTitle(raw: string, max = THREAD_NAME_MAX): string {
  const firstLine = raw.replace(/\r/g, "").split("\n").find((l) => l.trim().length > 0) ?? "";
  const unwrapped = firstLine
    .trim()
    .replace(/^(?:title|標題|タイトル)\s*[:：]\s*/i, "")
    // Matched wrappers models add: "…", '…', 「…」, 『…』, «…», ‘…’, “…”
    .replace(/^["'“”‘’「『«]+/, "")
    .replace(/["'“”‘’」』»]+$/, "")
    .replace(/[.。]+$/, "")
    .trim();
  // deriveThreadTitle also strips markdown emphasis, bidi/control characters and
  // collapses whitespace — the same normalisation the heuristic path uses, so a
  // model-supplied title can't be formatted or spoofed differently.
  return deriveThreadTitle(unwrapped, max);
}

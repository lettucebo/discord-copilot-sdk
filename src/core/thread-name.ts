import { hasBidiOrControls } from "./text-safety.js";

/** Discord's hard limit for a channel/thread name (1-100 characters).
 *  Source: https://docs.discord.com/developers/resources/channel — Channel
 *  Structure, `name`: "the name of the channel (1-100 characters)". */
export const THREAD_NAME_MAX = 100;

/**
 * Turn a user's first prompt into a short sidebar-readable title.
 *
 * This is the FALLBACK path: the primary title comes from a small model (see
 * `core/title.ts`), which produces something far better than a truncated first
 * line. Used when the titler is disabled or fails.
 *
 * Returns "" when the prompt has no usable text, so the caller can fall back to
 * a timestamp rather than naming a thread after nothing.
 *
 * No ordinal is prepended: Discord orders a channel's threads by creation
 * (verified 2026-07-28 — posting the newest message into an older thread did
 * NOT move it above a newer one in either the sidebar or the Threads browser),
 * so a "#012 ·" prefix would convey nothing while consuming about a quarter of
 * the width the sidebar actually renders.
 */
export function deriveThreadTitle(prompt: string, max = THREAD_NAME_MAX): string {
  const lines = prompt.replace(/\r/g, "").split("\n");
  let inFence = false;
  const candidates: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    // Prefer prose; keep fenced code only as a last resort (a prompt can be
    // nothing but a code block).
    if (inFence) candidates.push(cleaned);
    else return truncate(cleaned, max);
  }
  return candidates.length ? truncate(candidates[0]!, max) : "";
}

/** Strip the markdown scaffolding and unsafe characters that read badly (or
 *  spoof) in a sidebar, then collapse whitespace. */
function cleanLine(line: string): string {
  let s = line;
  if (hasBidiOrControls(s)) {
    // Same class the approval cards reject — a thread name is display-only, so
    // strip rather than refuse, but never render the spoofing characters.
    s = s.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u2028\u2029\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }
  return s
    .replace(/^\s*#{1,6}\s*/, "") // markdown heading
    .replace(/^\s*[-*+]\s+/, "") // list bullet
    .replace(/^\s*\[[ xX]\]\s*/, "") // task checkbox left by the bullet strip
    .replace(/^\s*>\s*/, "") // blockquote
    .replace(/[*_`~]/g, "") // inline emphasis / code marks
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Cut on CODE POINTS, not UTF-16 units: splitting a surrogate pair leaves a
  // lone surrogate, and `threads.create()` rejects such a name on a path with no
  // local catch (cmdNew), leaving the deferred ephemeral reply hanging forever.
  // Then shrink until the UTF-16 length also fits, because it is not documented
  // which unit Discord counts and the stricter reading costs at most a character.
  const points = [...s];
  let take = Math.min(points.length, max - 1);
  let out = points.slice(0, take).join("") + "…";
  while (out.length > max && take > 0) {
    take--;
    out = points.slice(0, take).join("") + "…";
  }
  return out;
}

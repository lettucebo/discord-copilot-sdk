/** Unicode ranges with no legitimate use in a shell command / approval card,
 *  but which can visually reorder or spoof text (BiDi overrides, isolates,
 *  L/R marks) — plus the C0 controls we strip for display. One character class,
 *  used for BOTH detection and stripping so they can never diverge: any char we
 *  would strip is also one we REJECT on a command (stripping it would make the
 *  card differ from what runs). Intentionally excludes tab/newline/CR
 *  (\u0009,\u000A,\u000D), which are legitimate in shell commands. */
const UNSAFE_CLASS =
  "\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u2028\\u2029\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F";
const UNSAFE_DETECT = new RegExp("[" + UNSAFE_CLASS + "]");
const UNSAFE_STRIP = new RegExp("[" + UNSAFE_CLASS + "]", "g");

/** True if the text contains bidirectional/control characters used for visual
 *  spoofing. A command containing ANY of them must be auto-denied, never
 *  displayed — this is exactly the set `sanitizeForCodeBlock` would strip, so
 *  the card can never differ from what actually executes. */
export function hasBidiOrControls(s: string): boolean {
  return UNSAFE_DETECT.test(s);
}

/**
 * Make text safe to place inside a Discord ```` ``` ```` block. A zero-width
 * space is inserted after each backtick so no ```` ``` ```` run can terminate
 * the block early (fence breakout), and stray control chars are stripped. Use
 * ONLY after `hasBidiOrControls` has already rejected spoofing input — this is
 * the display transform, not the safety gate.
 */
export function sanitizeForCodeBlock(s: string): string {
  return s.replace(UNSAFE_STRIP, "").replace(/`/g, "`\u200b");
}

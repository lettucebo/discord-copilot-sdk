/** Unicode ranges with no legitimate use in a shell command / approval card,
 *  but which can visually reorder or spoof text (BiDi overrides, isolates,
 *  L/R marks). Their presence is treated as a spoofing signal → auto-deny. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/;
/** BiDi + other zero-width/format/control chars to strip for safe DISPLAY. */
const DISPLAY_STRIP =
  /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u2028\u2029\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** True if the text contains bidirectional/control characters used for visual
 *  spoofing. A command containing these must be auto-denied, never displayed
 *  (stripping them for display would make the card differ from what runs). */
export function hasBidiOrControls(s: string): boolean {
  return BIDI_CONTROL.test(s);
}

/**
 * Make text safe to place inside a Discord ```` ``` ```` block. A zero-width
 * space is inserted after each backtick so no ```` ``` ```` run can terminate
 * the block early (fence breakout), and stray control chars are stripped. Use
 * ONLY after `hasBidiOrControls` has already rejected spoofing input — this is
 * the display transform, not the safety gate.
 */
export function sanitizeForCodeBlock(s: string): string {
  return s.replace(DISPLAY_STRIP, "").replace(/`/g, "`\u200b");
}

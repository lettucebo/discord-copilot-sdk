// Pure .env parse / merge / serialize, matching Node's built-in `util.parseEnv`
// (the parser `process.loadEnvFile` uses). Node built-ins only — safe to run
// before `npm install`. Verified against parseEnv semantics:
//  - unquoted `#` begins an inline comment; unquoted trailing whitespace is trimmed;
//  - a value is quote-stripped only if it STARTS with a matching ' or " quote;
//  - Node does NOT support `\"`-escaped quotes inside a quoted value, so a value
//    containing a double-quote (or a newline) cannot be represented and is rejected.

const KV_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Detect the dominant EOL of a file (CRLF if any is present, else LF). */
export function detectEol(text) {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

/** Parse into an ordered list of lines: {kind:"kv",key,raw} | {kind:"other",raw}.
 *  Comment/blank lines and non-managed content are kept verbatim as "other". */
export function parseLines(text) {
  const body = text.split(/\r?\n/);
  return body.map((raw) => {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("#") || trimmed === "") return { kind: "other", raw };
    const m = KV_RE.exec(raw);
    if (!m) return { kind: "other", raw };
    return { kind: "kv", key: m[1], raw };
  });
}

/** Serialize a single KEY=value line for Node's parseEnv. Quotes when the value
 *  has whitespace / `#` / a quote char (so it round-trips), and REJECTS values
 *  that parseEnv cannot represent (embedded `"` or newline). */
export function serializeLine(key, value) {
  if (typeof value !== "string") throw new Error(`value for ${key} must be a string`);
  if (value.includes('"')) {
    throw new Error(`value for ${key} contains a double-quote, which .env cannot safely represent`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`value for ${key} contains a newline, which .env cannot safely represent`);
  }
  if (value === "") return `${key}=`;
  const needsQuote = /[#\s'"]/.test(value);
  return needsQuote ? `${key}="${value}"` : `${key}=${value}`;
}

/**
 * Merge `updates` (a plain object of KEY→value) into existing `.env` text,
 * changing ONLY those keys: the first existing occurrence of each key is
 * rewritten in place; keys not present are appended. All other lines (comments,
 * blanks, unmanaged keys, order, and the file's EOL style) are preserved. A key
 * whose update value is `undefined`/`null` is skipped (not written).
 */
export function mergeEnv(existingText, updates) {
  const eol = detectEol(existingText || "");
  const lines = parseLines(existingText || "");
  const remaining = new Map(
    Object.entries(updates).filter(([, v]) => v !== undefined && v !== null)
  );

  const out = lines.map((line) => {
    if (line.kind === "kv" && remaining.has(line.key)) {
      const value = remaining.get(line.key);
      remaining.delete(line.key);
      return { kind: "kv", key: line.key, raw: serializeLine(line.key, String(value)) };
    }
    return line;
  });

  // Drop trailing empty lines so appends don't create a widening gap; we re-add
  // exactly one terminating EOL at the end.
  while (out.length && out[out.length - 1].kind === "other" && out[out.length - 1].raw === "") {
    out.pop();
  }
  for (const [key, value] of remaining) {
    out.push({ kind: "kv", key, raw: serializeLine(key, String(value)) });
  }

  return out.map((l) => l.raw).join(eol) + eol;
}

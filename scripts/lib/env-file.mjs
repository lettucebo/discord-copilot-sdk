// Pure .env parse / merge / serialize, matching Node's built-in `util.parseEnv`
// (the parser `process.loadEnvFile` uses). Node built-ins only — safe to run
// before `npm install`. serializeLine is SELF-VERIFYING: it picks the first
// representation that round-trips EXACTLY through the real parseEnv, so it can
// never silently corrupt a value (e.g. a Windows path like `C:\new repo`, where
// a double-quoted `\n` would be turned into a newline — unquoted preserves it).
import { parseEnv } from "node:util";

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

/** Serialize a single KEY=value line. Tries candidate representations and returns
 *  the FIRST that round-trips EXACTLY through Node's own parseEnv; throws if the
 *  value cannot be represented (embedded NUL / newline, or an unrepresentable
 *  quote). This guarantees the written value equals the value the runtime loads. */
export function serializeLine(key, value) {
  if (typeof value !== "string") throw new Error(`value for ${key} must be a string`);
  if (value.includes("\0")) throw new Error(`value for ${key} contains a NUL byte`);
  if (/[\r\n]/.test(value)) throw new Error(`value for ${key} contains a newline, which .env cannot represent`);

  const candidates = value === "" ? [`${key}=`] : [`${key}=${value}`]; // prefer unquoted (preserves backslashes)
  if (value !== "" && !value.includes('"')) candidates.push(`${key}="${value}"`); // fall back to double-quoted
  for (const line of candidates) {
    let parsed;
    try {
      parsed = parseEnv(line);
    } catch {
      continue;
    }
    if (parsed[key] === value) return line;
  }
  throw new Error(`value for ${key} cannot be safely represented in .env`);
}

/**
 * Physically REMOVE `keys` from `.env` text, replacing each line with a comment
 * that records what was dropped (never the value — it may be a secret).
 *
 * `mergeEnv` cannot do this: it preserves every line it does not manage, which
 * is exactly right for comments and unrelated settings, and exactly wrong for a
 * key the runtime now REJECTS. A migrated install that left
 * `CONTROLLED_REPO_PATH=` in the file would report success and then refuse to
 * start, which is the failure mode the whole two-sided config contract exists to
 * prevent.
 */
export function dropEnvKeys(existingText, keys) {
  const drop = new Set(keys);
  if (drop.size === 0) return existingText || "";
  const eol = detectEol(existingText || "");
  const lines = parseLines(existingText || "");
  const out = lines.map((line) =>
    line.kind === "kv" && drop.has(line.key)
      ? { kind: "other", raw: `# (removed in this version) ${line.key}` }
      : line
  );
  return out.map((l) => l.raw).join(eol) + eol;
}

/**
 * Merge `updates` (a plain object of KEY→value) into existing `.env` text,
 * changing ONLY those keys. Because Node's parseEnv resolves a duplicated key to
 * its LAST occurrence, we rewrite the LAST occurrence of each managed key (and
 * blank out any earlier duplicate managed lines to a comment so the written value
 * is unambiguously the effective one). Keys not present are appended. All other
 * lines (comments, blanks, unmanaged keys, order, EOL) are preserved. A key whose
 * update value is `undefined`/`null` is skipped.
 */
export function mergeEnv(existingText, updates) {
  const eol = detectEol(existingText || "");
  const lines = parseLines(existingText || "");
  const wanted = new Map(Object.entries(updates).filter(([, v]) => v !== undefined && v !== null));

  // Index of the LAST occurrence of each managed key.
  const lastIndex = new Map();
  lines.forEach((line, i) => {
    if (line.kind === "kv" && wanted.has(line.key)) lastIndex.set(line.key, i);
  });

  const applied = new Set();
  const out = lines.map((line, i) => {
    if (line.kind !== "kv" || !wanted.has(line.key)) return line;
    if (lastIndex.get(line.key) === i) {
      applied.add(line.key);
      return { kind: "kv", key: line.key, raw: serializeLine(line.key, String(wanted.get(line.key))) };
    }
    // Earlier duplicate of a managed key → neutralize it so it can't shadow the
    // effective (last) line. Redact the VALUE (it may be a stale secret) while
    // keeping the key name for traceability.
    return { kind: "other", raw: `# (superseded) ${line.key}=<redacted>` };
  });

  while (out.length && out[out.length - 1].kind === "other" && out[out.length - 1].raw === "") out.pop();
  for (const [key, value] of wanted) {
    if (!applied.has(key)) out.push({ kind: "kv", key, raw: serializeLine(key, String(value)) });
  }

  return out.map((l) => l.raw).join(eol) + eol;
}


// Pure installer-side validators + the managed-key catalog. Node built-ins only
// (runs before npm install). These MUST agree with the runtime schema in
// src/config.ts — a contract test (test/config-contract.test.ts) feeds the same
// corpus through both these validators and the real parseConfig and asserts they
// accept/reject identically, so they can't silently drift.

/** A single Discord snowflake, exactly as src/config.ts's `snowflake`. */
export const SNOWFLAKE_RE = /^\d{5,25}$/;

export function isSnowflake(v) {
  return typeof v === "string" && SNOWFLAKE_RE.test(v);
}

/** Split a comma-separated list the same way src/config.ts's `csv` does. */
export function csv(v) {
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validate DISCORD_ALLOWED_USER_IDS: ≥1 comma-separated snowflakes. */
export function isUserIdList(v) {
  const parts = csv(v);
  return parts.length >= 1 && parts.every((p) => SNOWFLAKE_RE.test(p));
}

export function isContextTier(v) {
  return v === "default" || v === "long_context";
}

export function isNonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * The keys the installer manages, in .env order, with metadata driving the
 * prompts and validation. `required` fields must be present; `secret` fields use
 * hidden input and are never echoed; `defaultValue` seeds a fresh install.
 */
export const MANAGED_KEYS = [
  { key: "DISCORD_BOT_TOKEN", required: true, secret: true, promptKey: "promptToken", validate: isNonEmpty, errKey: "errRequired" },
  { key: "DISCORD_ALLOWED_USER_IDS", required: true, promptKey: "promptUserIds", validate: isUserIdList, errKey: "errUserIds" },
  { key: "DISCORD_GUILD_ID", required: true, promptKey: "promptGuildId", validate: isSnowflake, errKey: "errSnowflake" },
  { key: "DISCORD_PARENT_CHANNEL_ID", required: true, promptKey: "promptParentChannelId", validate: isSnowflake, errKey: "errSnowflake" },
  { key: "CONTROLLED_REPO_PATH", required: true, promptKey: "promptRepoPath", validate: isNonEmpty, errKey: "errRequired" },
  { key: "DEV_GUILD_ID", required: false, optional: true, promptKey: "promptDevGuildId", validate: (v) => v === "" || isSnowflake(v), errKey: "errSnowflake" },
  { key: "DEFAULT_MODEL", required: false, defaultValue: "claude-sonnet-5", promptKey: "promptModel", validate: isNonEmpty, errKey: "errRequired" },
  { key: "DEFAULT_CONTEXT_TIER", required: false, defaultValue: "default", promptKey: "promptContextTier", validate: isContextTier, errKey: "errContextTier" },
];

/** Validate a full config object (installer view). Returns { ok, errors:[{key,errKey}] }. */
export function validateConfig(values) {
  const errors = [];
  for (const spec of MANAGED_KEYS) {
    const raw = values[spec.key];
    if (spec.required && !isNonEmpty(raw)) {
      errors.push({ key: spec.key, errKey: "errRequired" });
      continue;
    }
    if (spec.optional && (raw === undefined || raw === "")) continue; // absent optional is fine
    if (raw !== undefined && raw !== "" && !spec.validate(raw)) {
      errors.push({ key: spec.key, errKey: spec.errKey });
    }
  }
  return { ok: errors.length === 0, errors };
}

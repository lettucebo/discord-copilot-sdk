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

/** Exact spelling only: this mirrors src/config.ts's z.enum(["true", "false"]). */
export function isSkillSourceSwitch(v) {
  return v === "true" || v === "false";
}

export function isNonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/** A repo NAME (a single entry under REPOS_ROOT), not a path. Mirrors
 *  `repoNameLooksValid` in src/config.ts. */
export function isRepoName(v) {
  if (typeof v !== "string" || !v.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  if (v.includes("/") || v.includes("\\")) return false;
  if (v === "." || v === ".." || v.includes("..")) return false;
  return true;
}

export function isCloneHostPolicy(v) {
  return v === "github" || v === "allowlist";
}

/** Positive integer milliseconds within the range the runtime schema allows. */
export function isCloneTimeout(v) {
  if (typeof v !== "string" || v.trim() === "") return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 10_000 && n <= 3_600_000;
}

/** Config keys the runtime REJECTS outright. Mirrors `REMOVED_KEYS` in
 *  src/config.ts. Writing one of these into .env would produce an installer that
 *  reports success for a config the bot refuses to start with. */
export const REMOVED_KEYS = ["CONTROLLED_REPO_PATH", "SESSION_ISOLATION"];

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
  { key: "REPOS_ROOT", required: true, promptKey: "promptReposRoot", validate: isNonEmpty, errKey: "errRequired" },
  { key: "DEFAULT_REPO", required: false, optional: true, promptKey: "promptDefaultRepo", validate: isRepoName, errKey: "errRepoName" },
  { key: "DEV_GUILD_ID", required: false, optional: true, promptKey: "promptDevGuildId", validate: (v) => v === "" || isSnowflake(v), errKey: "errSnowflake" },
  { key: "DEFAULT_MODEL", required: false, defaultValue: "claude-sonnet-5", promptKey: "promptModel", validate: isNonEmpty, errKey: "errRequired" },
  { key: "DEFAULT_CONTEXT_TIER", required: false, defaultValue: "default", promptKey: "promptContextTier", validate: isContextTier, errKey: "errContextTier" },
  { key: "ENABLE_REPO_SKILLS", required: false, defaultValue: "true", promptKey: "promptRepoSkills", validate: isSkillSourceSwitch, errKey: "errSkillSourceSwitch" },
  { key: "ENABLE_USER_SKILLS", required: false, defaultValue: "true", promptKey: "promptUserSkills", validate: isSkillSourceSwitch, errKey: "errSkillSourceSwitch" },
];

/** Validate a full config object (installer view). Returns { ok, errors:[{key,errKey}] }. */
export function validateConfig(values) {
  const errors = [];
  for (const key of REMOVED_KEYS) {
    // Whitespace-only is not a configuration, matching `assertNoRemovedKeys`.
    if (isNonEmpty(values[key])) errors.push({ key, errKey: "errRemovedKey" });
  }
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
  // Cross-field rules the runtime schema enforces with .refine().
  if (values.REPO_CLONE_HOST_POLICY !== undefined && values.REPO_CLONE_HOST_POLICY !== "") {
    if (!isCloneHostPolicy(values.REPO_CLONE_HOST_POLICY)) {
      errors.push({ key: "REPO_CLONE_HOST_POLICY", errKey: "errCloneHostPolicy" });
    } else if (
      values.REPO_CLONE_HOST_POLICY === "allowlist" &&
      csv(values.REPO_CLONE_ALLOWED_HOSTS ?? "").length === 0
    ) {
      errors.push({ key: "REPO_CLONE_ALLOWED_HOSTS", errKey: "errCloneAllowlistEmpty" });
    }
  }
  if (values.REPO_CLONE_TIMEOUT_MS !== undefined && values.REPO_CLONE_TIMEOUT_MS !== "") {
    if (!isCloneTimeout(values.REPO_CLONE_TIMEOUT_MS)) {
      errors.push({ key: "REPO_CLONE_TIMEOUT_MS", errKey: "errCloneTimeout" });
    }
  }
  return { ok: errors.length === 0, errors };
}

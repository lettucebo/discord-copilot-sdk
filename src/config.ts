import { z } from "zod";

/** Split a comma-separated env value into a trimmed, non-empty list. */
const csv = (v: string): string[] =>
  v.split(",").map((s) => s.trim()).filter(Boolean);

const snowflake = z.string().regex(/^\d{5,25}$/, "must be a Discord snowflake id");
/** .default() only handles undefined, not an empty value from `.env`. These
 * switches must treat `KEY=` as unset or the installer/runtime contract splits:
 * the installer accepts an optional blank key while the runtime would reject it. */
const skillSourceSwitch = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.enum(["true", "false"]).default("true")
);

/**
 * discord-copilot-sdk config schema (v1, lab-only). Parsed from environment variables.
 * Discord scope is intentionally narrow: a single guild + a persisted first-run
 * work-channel default (additional work channels are enabled at runtime) + an explicit
 * user allow-list. `REPOS_ROOT` is the directory that CONTAINS every repo a
 * session may be bound to (⚠️ no isolation in v1 — run only in a disposable
 * environment).
 */
/** Require a non-blank string WITHOUT transforming it — trimming here would
 *  silently change a value like a Unix path `/tmp/x ` (a real, different
 *  directory) and redirect the repos-root boundary. */
const nonBlank = (msg: string) => z.string().refine((v) => v.trim().length > 0, msg);

/** Config keys that no longer exist, and what replaced each one.
 *
 *  These are REJECTED, not ignored. `z.object()` silently drops unknown keys, so
 *  deleting them from the schema would leave a `.env` that looks configured and
 *  boots with a completely different repo boundary than the one written in it.
 *  Both keys used to DEFINE that boundary, which is the one kind of ambiguity
 *  this project does not carry forward. (Contrast `legacyNameWarnings` in
 *  paths.ts, which only warns: those leftovers configure nothing either way.) */
export const REMOVED_KEYS: ReadonlyArray<readonly [string, string]> = [
  [
    "CONTROLLED_REPO_PATH",
    "REPOS_ROOT (the folder that CONTAINS your repos) plus optional DEFAULT_REPO (a name under it). " +
      "e.g. CONTROLLED_REPO_PATH=C:\\Source\\Repos\\my-repo becomes REPOS_ROOT=C:\\Source\\Repos and DEFAULT_REPO=my-repo",
  ],
  [
    "SESSION_ISOLATION",
    "nothing — isolation is now per thread. New sessions always get their own git worktree; " +
      "use `/repo dev local` in a thread to work directly in the repo instead",
  ],
];

/** Throw a readable migration error if a removed key is still set. */
export function assertNoRemovedKeys(env: Record<string, string | undefined>): void {
  // A whitespace-only value is not a configuration — treated the same as absent,
  // matching how the installer mirror decides (`isNonEmpty`).
  const found = REMOVED_KEYS.filter(([k]) => (env[k] ?? "").trim() !== "");
  if (found.length === 0) return;
  const lines = found.map(([k, replacement]) => `  - ${k} was removed. Use ${replacement}.`);
  throw new Error(
    `Your configuration still sets ${found.length === 1 ? "a key that no longer exists" : "keys that no longer exist"}:\n` +
      `${lines.join("\n")}\n` +
      `Remove the old line(s) from .env, or re-run the installer, which migrates them for you.`
  );
}

/** A repo NAME (a single entry under REPOS_ROOT), not a path. Mirrored by
 *  `scripts/lib/validate.mjs` — keep the two in step. */
export function repoNameLooksValid(v: string): boolean {
  if (!v || !v.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  if (v.includes("/") || v.includes("\\")) return false;
  if (v === "." || v === ".." || v.includes("..")) return false;
  return true;
}

export const ConfigSchema = z.object({
  DISCORD_BOT_TOKEN: nonBlank("DISCORD_BOT_TOKEN is required"),
  DISCORD_ALLOWED_USER_IDS: z
    .string()
    .min(1, "DISCORD_ALLOWED_USER_IDS is required")
    .transform(csv)
    .pipe(z.array(snowflake).min(1, "at least one allowed user id is required")),
  DISCORD_GUILD_ID: snowflake,
  /** First-run work-channel default; afterwards it is an ordinary registry entry. */
  DISCORD_PARENT_CHANNEL_ID: snowflake,
  /** Absolute path to the directory that CONTAINS the repos a session may touch.
   *  Not a repo itself — see `resolveReposRoot`, which does the filesystem checks
   *  this (deliberately I/O-free) schema cannot. */
  REPOS_ROOT: nonBlank("REPOS_ROOT is required"),
  /** Name of the repo under REPOS_ROOT that `/new` binds to when no `repo:` is
   *  given. Unset means `/new` must always be told which repo. */
  DEFAULT_REPO: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().refine(repoNameLooksValid, "DEFAULT_REPO must be a single repo NAME under REPOS_ROOT, not a path").optional()
  ),
  DEFAULT_MODEL: nonBlank("DEFAULT_MODEL must not be blank").default("claude-sonnet-5"),
  DEFAULT_CONTEXT_TIER: z.enum(["default", "long_context"]).default("default"),
  /** Explicit roots let a controlled repo supply skills without enabling broad
   * config/MCP discovery. Each source is independently switchable. */
  ENABLE_REPO_SKILLS: skillSourceSwitch,
  ENABLE_USER_SKILLS: skillSourceSwitch,
  /** Which hosts `/repo clone` may fetch from. `github` (default) is the only
   *  value that needs no further thought; `allowlist` requires naming hosts.
   *  There is deliberately no "any public host" option — hostname text alone
   *  cannot stop DNS pointing at an internal address. */
  REPO_CLONE_HOST_POLICY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["github", "allowlist"]).default("github")
  ),
  REPO_CLONE_ALLOWED_HOSTS: z.preprocess(
    (v) => (v === "" || v === undefined ? [] : typeof v === "string" ? csv(v) : v),
    z.array(z.string().min(1)).default([])
  ),
  REPO_CLONE_TIMEOUT_MS: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? Number(v) : v),
    z.number().int().min(10_000).max(3_600_000).default(300_000)
  ),
  /** Model used to name a new thread from its first message. `off` disables it
   *  (threads then fall back to a truncated first line). Empty = auto-pick the
   *  cheapest available model from `TITLE_MODEL_PREFERENCE`. */
  TITLE_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
}).refine(
  (c) => c.REPO_CLONE_HOST_POLICY !== "allowlist" || c.REPO_CLONE_ALLOWED_HOSTS.length > 0,
  {
    path: ["REPO_CLONE_ALLOWED_HOSTS"],
    message: "REPO_CLONE_ALLOWED_HOSTS must name at least one host when REPO_CLONE_HOST_POLICY=allowlist",
  }
);

export type Config = z.infer<typeof ConfigSchema>;

/** Parse + validate a raw env record. Throws a readable error listing every
 *  invalid/missing field (never leaks values). Pure — unit-testable. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  assertNoRemovedKeys(env);
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`
    );
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Load config from process.env. */
export function loadConfig(): Config {
  return parseConfig(process.env);
}

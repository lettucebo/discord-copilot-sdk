import { z } from "zod";

/** Split a comma-separated env value into a trimmed, non-empty list. */
const csv = (v: string): string[] =>
  v.split(",").map((s) => s.trim()).filter(Boolean);

const snowflake = z.string().regex(/^\d{5,25}$/, "must be a Discord snowflake id");

/**
 * discopilot config schema (v1, lab-only). Parsed from environment variables.
 * Discord scope is intentionally narrow: a single guild + parent channel + an
 * explicit user allow-list. `CONTROLLED_REPO_PATH` is the ONE repo a session may
 * touch (⚠️ no isolation in v1 — run only in a disposable environment).
 */
export const ConfigSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_ALLOWED_USER_IDS: z
    .string()
    .min(1, "DISCORD_ALLOWED_USER_IDS is required")
    .transform(csv)
    .pipe(z.array(snowflake).min(1, "at least one allowed user id is required")),
  DISCORD_GUILD_ID: snowflake,
  DISCORD_PARENT_CHANNEL_ID: snowflake,
  DEV_GUILD_ID: snowflake.optional(),
  CONTROLLED_REPO_PATH: z.string().min(1, "CONTROLLED_REPO_PATH is required"),
  DEFAULT_MODEL: z.string().min(1).default("claude-sonnet-5"),
  DEFAULT_CONTEXT_TIER: z.enum(["default", "long_context"]).default("default"),
  PERMISSION_POLICY: z.enum(["ask"]).default("ask"),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parse + validate a raw env record. Throws a readable error listing every
 *  invalid/missing field (never leaks values). Pure — unit-testable. */
export function parseConfig(env: Record<string, string | undefined>): Config {
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

// Pure planning for uninstall. Kept free of side effects on purpose: this is the
// one script whose bugs delete things, so every decision about WHAT to remove
// (and what to refuse) is unit-testable without touching a disk.
//
// Nothing here performs I/O. `scripts/uninstall.mjs` gathers the inventory,
// hands it in, prints the plan, and only then acts.

/** Things the tool creates that an uninstall may remove. */
export const STEPS = [
  "residency", // scheduled task / launchd plist / systemd unit + its wrapper
  "process", // the running bot
  "commands", // Discord guild slash commands
  "worktrees", // per-session git worktrees
  "branches", // copilot/t-* branches
  "state", // ~/.discord-copilot-sdk (approvals, session store, logs, env backups)
  "legacy", // pre-rename ~/.discopilot
  "env", // .env (holds the bot token)
];

/**
 * Order the removal steps.
 *
 * Two orderings are load-bearing, not stylistic:
 *
 * 1. **`commands` BEFORE `env`.** Deregistering the guild's slash commands needs
 *    the bot token, and the only copy of it is in `.env`. Delete the file first
 *    and the commands are stranded in Discord with no way for this tool to reach
 *    them again.
 * 2. **`residency` BEFORE `process`.** The scheduler is the lifecycle authority:
 *    the task/unit restarts the bot within a minute, so killing the process
 *    first just means it comes back mid-uninstall.
 */
export function orderSteps(steps) {
  const rank = new Map(STEPS.map((s, i) => [s, i]));
  return [...steps].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
}

/**
 * Decide what an uninstall run will do.
 *
 * @param opts.keepConfig  keep `.env` so a reinstall does not re-ask for the IDs
 * @param opts.branches    also delete `copilot/t-*` branches (merged ones only)
 * @param opts.keepState   keep `~/.discord-copilot-sdk`
 * @returns {{steps: string[], refusals: string[]}}
 */
export function planUninstall(opts = {}) {
  const steps = new Set(STEPS);
  if (opts.keepConfig) steps.delete("env");
  if (opts.keepState) steps.delete("state");
  if (!opts.branches) steps.delete("branches");
  const refusals = [];
  if (opts.keepConfig) {
    // Say it plainly. "Uninstalled" while the bot token is still on disk is the
    // kind of half-truth this project does not ship.
    refusals.push("env:.env kept — it still contains your bot token");
  }
  if (!opts.branches) refusals.push("branches:copilot/t-* branches kept (they may hold commits)");
  return { steps: orderSteps([...steps]), refusals };
}

/**
 * What may be done with one worktree.
 *
 * The rule is the same one `/end` uses, for the same reason: a worktree is where
 * the agent did its work, and "uninstalling" is not a licence to throw away
 * something that exists nowhere else.
 *
 * @param status  porcelain output of `git status --porcelain --ignored=matching`
 * @param head    output of `git symbolic-ref --quiet HEAD`, or "" when detached
 * @param branch  the branch the record says should be checked out
 */
export function classifyWorktree(status, head, branch) {
  if (status === null) return "unknown"; // could not ask git — never guess
  if (status.trim().length > 0) return "dirty";
  if (branch && head !== `refs/heads/${branch}`) return "detached";
  return "removable";
}

/**
 * Things an uninstall must never touch, with the reason. Surfaced in the plan so
 * the operator can see the boundary rather than trust it.
 */
export const NEVER_TOUCHED = [
  ["the controlled repo itself", "it is your code; this tool only ever added worktrees and branches to it"],
  ["~/.copilot", "your Copilot CLI login belongs to the CLI, not to this tool"],
  ["node / git / the Copilot CLI", "installed as prerequisites and shared with everything else on the machine"],
  ["the Discord application", "only you can delete it, at https://discord.com/developers/applications"],
];

/** Steps that cannot be undone by re-running the installer. */
export function irreversible(steps) {
  const set = new Set(steps);
  const out = [];
  if (set.has("env")) out.push("env");
  if (set.has("branches")) out.push("branches");
  if (set.has("state")) out.push("state");
  return out;
}

/** Slash-command surface: the complete guild-command payload and the guild
 *  REST registration that ships it to Discord. Kept apart from the orchestrator
 *  so the payload can be golden-tested without constructing the app, and so a
 *  command definition change touches one file. */
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { EFFORT_LEVELS } from "../../core/effort.js";

export function restrictCommandDefaults<T extends object>(
  commands: readonly T[]
): Array<T & { default_member_permissions: "0" }> {
  return commands.map((command) => ({ ...command, default_member_permissions: "0" }));
}

/** Complete guild-command payload. Kept pure so a golden test can prove that a
 * refactor of command ownership does not change Discord registration. */
export function buildCommandRegistrationPayload(modelIds: readonly string[]) {
  const modelChoices = modelIds.slice(0, 25).map((id) => ({ name: id, value: id }));
  const commands = [
    new SlashCommandBuilder()
      .setName("new")
      .setDescription("Start a new Copilot session in a thread")
      .addStringOption((o) =>
        o.setName("prompt").setDescription("Optional first prompt").setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("repo")
          .setDescription("Repo under REPOS_ROOT (defaults to DEFAULT_REPO)")
          .setRequired(false)
          .setAutocomplete(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("repo")
      .setDescription("Which repo this thread works in, and how")
      .addSubcommand((s) => s.setName("show").setDescription("What this thread is bound to"))
      .addSubcommand((s) => s.setName("list").setDescription("Repos available under REPOS_ROOT"))
      .addSubcommand((s) =>
        s
          .setName("set")
          .setDescription("Bind this thread to a different repo (starts a fresh conversation)")
          .addStringOption((o) =>
            o.setName("name").setDescription("Repo name").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("dev")
          .setDescription("Work in this session's own worktree, or directly in the repo")
          .addStringOption((o) =>
            o
              .setName("mode")
              .setDescription("worktree (isolated, default) or local (edits the repo itself)")
              .setRequired(true)
              .addChoices(
                { name: "worktree — isolated copy for this session", value: "worktree" },
                { name: "local — work directly in the repo", value: "local" }
              )
          )
      )
      .addSubcommand((s) =>
        s
          .setName("clone")
          .setDescription("Clone a remote repo into REPOS_ROOT and bind this thread to it")
          .addStringOption((o) =>
            o
              .setName("source")
              .setDescription("owner/repo, https://…, ssh://…, or git@host:owner/repo")
              .setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("name").setDescription("Folder name (defaults to the repo name)").setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("new")
          .setDescription("Create a new empty git repo in REPOS_ROOT and bind this thread to it")
          .addStringOption((o) => o.setName("name").setDescription("New project name").setRequired(true))
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Abort the current turn in this session thread")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Switch this session's model (history preserved)")
      .addStringOption((o) => {
        o.setName("id").setDescription("Model id").setRequired(true);
        if (modelChoices.length) o.addChoices(...modelChoices);
        return o;
      })
      .toJSON(),
    new SlashCommandBuilder()
      .setName("effort")
      .setDescription("Set this session's reasoning effort")
      .addStringOption((o) =>
        o
          .setName("level")
          .setDescription("Reasoning effort (validated against the current model)")
          .setRequired(true)
          .addChoices(...EFFORT_LEVELS.map((l) => ({ name: l, value: l })))
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("context")
      .setDescription("Set this session's context window tier")
      .addStringOption((o) =>
        o
          .setName("tier")
          .setDescription("Context tier")
          .setRequired(true)
          .addChoices(
            { name: "default", value: "default" },
            { name: "long_context", value: "long_context" }
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("usage")
      .setDescription("Show this session's token usage")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("approvals")
      .setDescription("List (or clear) remembered command approvals")
      .addBooleanOption((o) =>
        o.setName("clear").setDescription("Clear this session + repo approvals").setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("diff")
      .setDescription("Show a git diff summary of the controlled repo")
      .addBooleanOption((o) =>
        o.setName("staged").setDescription("Show staged (--cached) changes instead").setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("file")
      .setDescription("Send one file from this session's workdir")
      .addStringOption((o) => o.setName("path").setDescription("Path inside this session workdir").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("todos")
      .setDescription("Show the agent's current todo checklist")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("yolo")
      .setDescription("⚠️ Auto-approve EVERY permission in this session (no prompts)")
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("Turn blanket auto-approval on or off")
          .setRequired(true)
          .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("rename")
      .setDescription("Rename this session thread")
      .addStringOption((o) =>
        o.setName("title").setDescription("New title for this thread").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Queue a prompt to run after the current turn (a plain message steers instead)")
      .addStringOption((o) =>
        o.setName("message").setDescription("Prompt to run next").setRequired(false)
      )
      .addBooleanOption((o) =>
        o.setName("clear").setDescription("Discard everything currently queued").setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("end")
      .setDescription("End THIS thread's session (other sessions keep running)")
      .addStringOption((o) =>
        o
          .setName("thread")
          .setDescription("Thread id of a leftover record whose thread is gone (see /sessions)")
          .setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("sessions")
      .setDescription("List the sessions running right now")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("channel")
      .setDescription("Manage which channels this bot answers in")
      .addSubcommand((s) =>
        s
          .setName("enable")
          .setDescription("Let sessions be started in a channel")
          .addStringOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel id or #mention (default: this channel)")
              .setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("disable")
          .setDescription("Stop answering in a channel (end its sessions first)")
          .addStringOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel id or #mention (default: this channel)")
              .setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s.setName("list").setDescription("Show which channels this bot answers in")
      )
      .toJSON(),
  ];
  return restrictCommandDefaults(commands);
}

export interface RegisterCommandsOptions {
  /** Bot token, used only to authenticate this one REST call. */
  botToken: string;
  /** Application (client) id of the logged-in bot. */
  clientId: string;
  /** Guild the commands are registered in — registration stays guild-scoped. */
  guildId: string;
  /** Model ids offered as /model choices; the payload caps these at Discord's 25-choice limit. */
  modelIds: readonly string[];
}

/** Register the guild command set. Guild-scoped and hidden from non-admins by
 *  default. The runtime owner + channel authorization remains the real
 *  boundary; this default only keeps the command picker quiet for ordinary
 *  members. */
export async function registerCommands({
  botToken,
  clientId,
  guildId,
  modelIds,
}: RegisterCommandsOptions): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(botToken);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: buildCommandRegistrationPayload(modelIds),
  });
}

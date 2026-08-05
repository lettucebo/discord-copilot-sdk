# Channel Access

> **English** · [繁體中文](CHANNEL-ACCESS.zh-TW.md)

This is the authoritative model for where the bot's commands appear, where the bot is allowed to act, and why those are two different decisions.

---

## 1. Two planes, and why the bot cannot hide its own commands

| Plane | Who configures it | What it controls | Is it a security boundary? |
| --- | --- | --- | --- |
| Discord | a server admin, in Server Settings → Integrations | whether the command **appears** in the `/` picker | **No** |
| Bot | the owner, with `/channel` | whether the bot **acts** on it | **Yes** |

Discord's picker visibility is based on the user's `USE_APPLICATION_COMMANDS` permission in that channel plus Application Command Permissions v2, not the bot's `VIEW_CHANNEL` permission ([source](https://docs.discord.com/developers/interactions/application-commands#application-command-permissions-object-using-default-permissions)). A **bot token cannot** call the command-permissions endpoint; Discord requires an OAuth2 bearer token with `applications.commands.permissions.update`, meaning a human has to authorize it ([source](https://docs.discord.com/developers/interactions/application-commands#permissions)). Therefore this bot can never hide its own commands.

Interactions also reach the bot regardless of channel permissions, and an initial interaction response does not require `SEND_MESSAGES` ([source](https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction)). That makes the bot's own `/channel` gate the real authorization boundary. If the bot simply did not answer a forbidden interaction, Discord would show "The application did not respond" after 3 seconds, so an ephemeral refusal is the quietest legal answer ([source](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback)).

---

## 2. Discord plane — hide the commands (admin, one-off, per server)

Use Server Settings → Integrations → the app → Command permissions. Deny the app for **All Channels**, then allow only the work channels.

This survives bot restarts. On every startup the bot bulk-`PUT`s its guild commands; Discord's bulk overwrite matches existing commands by command **name** and preserves the command ID when the name is unchanged ([source](https://docs.discord.com/developers/interactions/application-commands#bulk-overwrite-guild-application-commands-json-params)). Because unchanged command names are not new creates, they also do not consume the 200-creates-per-guild-per-day budget ([source](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)).

---

## 3. Bot plane — `/channel`

Command surface:

- `/channel enable [channel:<id or #mention>]` — enable the current channel, or the named one. `channel:` is a **string** option, so it also accepts a raw ID in the same style as `/end thread:<id>`.
- `/channel disable [channel:<id or #mention>]`
- `/channel list`

Rules:

- Only users in `DISCORD_ALLOWED_USER_IDS` may run `/channel`.
- The target must be a normal **text channel** in the configured guild. Threads, forum channels, announcement channels, and voice channels are refused.
- `DISCORD_PARENT_CHANNEL_ID` is the **seed** channel: always enabled, and `/channel disable` on it is refused. Change `.env` and restart instead.
- `enable` reports any missing bot permission in that channel — View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Embed Links, and Read Message History — but still enables it, because a permission is not an authorization. Manage Threads is optional for cleanup after a failed `/new`; it is not required or reported by this check.
- `disable` is **refused** while that channel still has a running session or a stored `active`/`creating` record. End them with `/end` first. This is deliberate: the bot never destroys work to tidy up.
- `/channel list` shows **bot authorization only**. It says nothing about whether Discord shows the commands.

The registry lives in `~/.discord-copilot-sdk/<instance>.channels.json`. A corrupt registry, or a registry for a different guild, makes the bot **refuse to start** rather than silently fall back to the seed channel. Silent fallback would mark every other channel's sessions `blocked`, which is not reversible. The uninstaller removes the registry with the rest of the state directory.

---

## 4. The order of operations

This is the part people get wrong: the admin's deny-all also hides `/channel` itself.

- **Adding a channel**: admin allows the channel in Integrations → owner runs `/channel enable` there. If commands are still hidden in the target channel, run `/channel enable channel:<id>` **from the seed channel** instead.
- **Removing a channel**: `/end` its sessions → `/channel disable` → admin denies the channel in Integrations.

---

## 5. Duplicate commands from a second app

If two Discord applications, for example `DisPilot` and `DisPilot-Test`, are both in the server, both register their own `/new`, `/diff`, `/context`, and the rest. The picker lists each one separately, labelled with its own app.

Multiple apps may legally share command names, and the platform offers no way to suppress one app from the other side ([source](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)). The only fixes are to remove the second app from the server, or restrict it in Integrations to its own test channel.

---

## 6. `blocked` is terminal

If a channel leaves the enabled set while sessions still point at it — because of a hand-edited registry, a changed seed in `.env`, or a corrupt store — those session records are marked `blocked` at the next startup. Re-enabling the channel does **not** revive them.

Clear them with `/end thread:<id>`, which also reclaims the worktree when git proves it clean.

---

## 7. Verify — do both directions

- **Positive**: in an enabled channel, `/` lists the commands, `/new` opens a thread, and typing in the thread gets a reply.
- **Negative**: in a channel you did not enable, `/` must **not** list the commands. If you can still invoke one because the admin step is missing, the only thing you get is an ephemeral refusal — the bot does nothing.

**Only the negative test proves the thing you actually wanted.**

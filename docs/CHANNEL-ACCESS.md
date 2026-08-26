# Channel Access

> **English** · [繁體中文](CHANNEL-ACCESS.zh-TW.md)

This is the authoritative model for where the bot's commands appear, where the bot is allowed to act, and why those are separate decisions.

---

## 1. Three planes

| Plane | Who configures it | What it controls | Is it a security boundary? |
| --- | --- | --- | --- |
| Bot authorization | the owner, with `/channel` | whether the bot **acts** on a channel | **Yes** — this is the real boundary |
| Bot visibility (channel membership) | a server admin, by making the work channel **private** and adding only this bot's app | whether the bot receives the channel's content **and** whether its commands appear there (§3) | **Primary mechanism** for hiding the bot elsewhere |
| Discord command permissions | a server admin, in Server Settings → Integrations | a per-app override of command visibility on top of the visibility plane | Secondary/manual; see §5 |

`/channel` is the only bot-side authorization surface (§2). Sections 3–5 are about where the bot's slash commands *appear* and where its gateway events reach it — that is a Discord-platform concern, not authorization, but it is the layer that actually stops other people in the server from ever seeing this bot exists.

Interactions reach the bot's backend regardless of the channel's send/read permissions, and an initial interaction response does not require `SEND_MESSAGES` ([source](https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction)). That is why `/channel` — not Discord visibility — is the actual authorization boundary: if a command is ever reachable somewhere it shouldn't be, the bot must still refuse it. If the bot simply did not answer a forbidden interaction, Discord would show "The application did not respond" after 3 seconds, so an ephemeral refusal is the quietest legal answer ([source](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback)).

---

## 2. Bot plane — `/channel` (the authorization boundary)

Command surface:

- `/channel enable [channel:<id or #mention>]` — enable the current channel, or the named one. `channel:` is a **string** option, so it also accepts a raw ID in the same style as `/end thread:<id>`.
- `/channel disable [channel:<id or #mention>]`
- `/channel list`

Rules:

- Only users in `DISCORD_ALLOWED_USER_IDS` may run `/channel`.
- The target must be a normal **text channel** in the configured guild. Threads, forum channels, announcement channels, and voice channels are refused.
- `DISCORD_PARENT_CHANNEL_ID` is the **seed default**: the value that is authorized automatically the first time the bot ever starts, so there is always at least one usable channel out of the box. It is imported once into the registry; after that first run it is an ordinary enabled-channel record like any other — it can be disabled once no session still needs it, exactly like a channel added later with `/channel enable`. Editing `DISCORD_PARENT_CHANNEL_ID` in `.env` after the registry exists does **not** change authorization. (`first-run default` is the operator-facing descriptive synonym for this same seed default.)
- `enable` reports any missing bot permission in that channel — View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Embed Links, and Read Message History — but still enables it, because a permission is not an authorization. Manage Threads is optional for cleanup after a failed `/new`; it is not required or reported by this check.
- `enable` on a channel the bot cannot currently **see** is refused with a precise instruction: add the bot to that private channel first (§3), then re-run `/channel enable`. Authorizing a channel the bot can't see would create an enabled record with no way to act on it.
- `disable` is **refused** while that channel still has a running session or a stored `active`/`creating` record. End them with `/end` first. This is deliberate: the bot never destroys work to tidy up.
- `/channel list` shows **bot authorization**, cross-checked against what the bot can currently see, so drift (authorized but no longer visible, or visible but never authorized) is surfaced rather than hidden.

The registry lives in `~/.discord-copilot-sdk/<instance>.channels.json`. A corrupt registry, or a registry for a different guild, makes the bot **refuse to start** rather than silently fall back to the seed default. Silent fallback would mark every other channel's sessions blocked, which is not reversible. The uninstaller removes the registry with the rest of the state directory.

---

## 3. Primary model — private work channels (the recommended way to hide the bot)

Making a work channel **private** and adding only this bot's application to it is Discord's own native whitelist: a bot that is not a member of a channel does not receive that channel's gateway events, and — per the corrected claim in §4 — its slash commands do not appear in that channel's `/` picker either. No Integrations configuration is required to get this effect; it falls out of ordinary Discord channel permissions.

**Setup, per work channel:**

1. Create (or edit) the channel → set it **private** (remove `@everyone`'s View Channel, or create it as private from the start).
2. Edit Channel → Permissions → add **only this bot's application** (and the humans who should use it) as members/overwrites with View Channel plus the permission set in [`DISCORD-SETUP.md`](DISCORD-SETUP.md#4b--confine-what-the-bot-can-read).
3. Run `/channel enable` in that channel (or `/channel enable channel:<id>` from an already-enabled channel).

**Multiple bot instances in one server** (for example a production app and a test app): create a separate Discord application per instance, and add each application's bot **only** to the channel(s) it should own. Since each app is a distinct member set, the production bot's commands never appear in the test channel and vice versa — this replaces manually policing Integrations per app (§6).

**Removing a channel from the whitelist:** `/end` its sessions → `/channel disable` → remove the bot's membership/overwrite from the channel. Do the disable before revoking Discord-level access, otherwise `/channel disable` may itself become unreachable if that was the only channel authorization was being managed from.

> If the bot loses its own View Channel on a channel unexpectedly (someone edits permissions, a role change, etc.), API calls against that channel — including for existing sessions bound to it — fail with `50001 Missing Access`. Per [ADR-0002](adr/0002-missing-access-is-retryable.md), that specific failure is treated as **retryable**, not terminal: restoring the bot's access is expected to let the affected sessions resume, unlike the structural mismatches described in §7. `/sessions` lists such `thread-no-access` records in their own section — retryable after access is restored or on restart, but the owner can also deliberately abandon one by clearing it with `/end thread:<id>`.

---

## 4. Correcting a stale claim: bot `VIEW_CHANNEL` **does** affect command visibility

An earlier version of this document (and of `DISCORD-SETUP.md`) claimed that denying the bot `VIEW_CHANNEL` in a channel confines only what it can *read*, and has no effect on whether its slash commands appear in that channel's `/` picker. **That claim was wrong and is retracted.** If the bot is not a member of a channel (no `VIEW_CHANNEL`), its slash commands do **not** appear in that channel's `/` picker for anyone ([Discord Slash Commands FAQ](https://support-dev.discord.com/hc/en-us/articles/frequently-asked-questions); [Command Permissions](https://support.discord.com/hc/en-us/articles/9349445088791-Command-Permissions-FAQ); [discord-api-docs discussion #4959](https://github.com/discord/discord-api-docs/discussions/4959)). This is exactly the mechanism §3 relies on as the primary whitelist.

**Evidence level:** the sources above are consistent secondhand documentation (support articles and a maintained community discussion thread), not a first-party API reference statement. Treat §9's positive/negative verification as the step that actually closes this out for your server; if it is ever contradicted by a live test, the primary model in §3 still holds for read-confinement and preventing mention messages from reaching the bot — only the command-picker part would fall back to §5's Integrations override.

Command-permission overrides via Integrations (§5) are a separate, additional layer on top of this: they can further restrict visibility for a bot that *is* visible to the channel, but they cannot make a bot's commands appear in a channel it cannot see.

---

## 5. Secondary/future option — Discord Integrations command permissions

Use Server Settings → Integrations → the app → Command permissions when you need finer-grained visibility control than "this bot is or isn't a member of the channel" — for example, restricting *which allow-listed humans* can invoke the command inside a channel the bot already shares, or layering an extra deny on top of §3 for defense in depth. Deny the app for **All Channels**, then allow only the work channels.

**Why this cannot be automated by the bot:** changing Application Command Permissions requires an OAuth2 bearer token for a human user who holds Manage Guild and Manage Roles in that guild, calling `applications.commands.permissions.update` ([source](https://docs.discord.com/developers/interactions/application-commands#permissions)). The bot's own token has no equivalent scope and cannot call this endpoint under any configuration — there is no service-account or bot-token path to this endpoint, so this step is permanently a manual, human, per-server action, not a gap this project intends to close in a future version. This is also why it is documented here as **secondary**: §3 needs no human OAuth grant and no per-app manual maintenance to keep working.

This setting survives bot restarts. On every startup the bot bulk-`PUT`s its guild commands; Discord's bulk overwrite matches existing commands by command **name** and preserves the command ID when the name is unchanged ([source](https://docs.discord.com/developers/interactions/application-commands#bulk-overwrite-guild-application-commands-json-params)). Because unchanged command names are not new creates, they also do not consume the 200-creates-per-guild-per-day budget ([source](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)).

Command registration also sets `default_member_permissions="0"` on every command, meaning nobody in the guild can invoke it by default unless they hold Administrator or have an explicit per-user/per-role override here in Integrations ([source](https://docs.discord.com/developers/interactions/application-commands#permissions)). If any user in `DISCORD_ALLOWED_USER_IDS` is not a guild Administrator, they need such an override added here before they can use the commands at all — see [`DISCORD-SETUP.md`](DISCORD-SETUP.md) for the startup warning that flags this.

---

## 6. Duplicate commands from a second app

If two Discord applications, for example `DisPilot` and `DisPilot-Test`, both share visibility into the same channel, both register their own `/new`, `/diff`, `/context`, and the rest. The picker lists each one separately, labelled with its own app.

Multiple apps may legally share command names, and the platform offers no way to suppress one app from the other side ([source](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)). Under the private-channel model in §3, the fix is structural: give each app its own dedicated channel(s) so their member sets never overlap. Restricting one app to its own channel via Integrations (§5) also works, but is the manual fallback, not the default.

---

## 7. `blocked` is terminal — and how that differs from retryable no-access

If a hand-edited or externally restored registry no longer contains a parent channel while session records still point at it, those records are marked `blocked` at the next startup. Re-enabling the channel does **not** revive them. This is a **structural** mismatch: the record's authorization no longer matches reality, and there is no safe way to tell whether re-enabling means "restore the old binding" or "coincidentally reuse the id for something else." Editing `DISCORD_PARENT_CHANNEL_ID` after registry creation does not cause this; the persisted registry remains authoritative.

This is different from the bot simply losing its own channel access (§3's callout, [ADR-0002](adr/0002-missing-access-is-retryable.md)): that is `no-access`, and it is retryable, because nothing about the authorization record or the thread/parent relationship changed — only the bot's own visibility did.

Clear a genuinely terminal `blocked` record with `/end thread:<id>`, which also reclaims the worktree when git proves it clean.

---

## 8. Channel Obfuscation (2026-08-12 change, mandatory 2026-11-16)

Discord announced a breaking change to how channels the bot cannot see are represented, effective now and **mandatory for all bots from 2026-11-16** ([change log](https://docs.discord.com/developers/change-log)):

- A channel the bot has no `VIEW_CHANNEL` access to is still **dispatched over the Gateway**, but obfuscated: its `name` becomes the literal string `"___hidden___"`, other sensitive fields are cleared, its `flags` include the bit `CHANNEL_OBFUSCATED` (`1 << 17`), and `permission_overwrites` is reduced to a single entry denying `VIEW_CHANNEL` for `@everyone`.
- **HTTP omission**: `GET /guilds/{guild.id}/channels` and similar REST listing calls **omit these channels entirely** rather than returning an obfuscated stub. Do not treat "missing from the REST channel list" as "channel deleted."
- The moment the bot gains access, the Gateway sends a `CHANNEL_UPDATE` with the real, de-obfuscated data.
- **Interaction payload exception**: this obfuscation does **not** apply to the channel data carried inside an interaction payload (`INTERACTION_CREATE`). A user invoking a command still causes Discord to hand the bot the real channel reference for that one interaction, so the bot can respond — this is a narrow exception for responding to the triggering interaction, not a general read grant.
- You can test the Gateway-side behavior **today**, ahead of the mandatory date, via Developer Portal → your application → **Bot** tab → **Private Channel Obfuscation** (or the IDENTIFY `capabilities` bit `1 << 15`). There is no equivalent early-opt-in for the HTTP side; it will simply start omitting channels once the change is live for your app.

**Practical implication for this bot:** any code path that reads a channel's `name`, or enumerates `guild.channels`, must not display `"___hidden___"` (or a cached pre-obfuscation name) as if it were real, and must not conclude a channel was deleted just because it disappeared from a REST listing call.

---

## 9. Verify — do both directions

- **Positive**: in a channel the bot is a member of and that is enabled, `/` lists the commands, `/new` opens a thread, and typing in the thread gets a reply.
- **Negative (visibility)**: in a private channel the bot was never added to, `/` must **not** list the commands. A user can still *type* an `@`-mention of the bot — Discord does not prevent that text — but because the bot is not a member of the channel it never receives, reads, or responds to that message. This is the test that actually confirms §4's corrected claim for your server/client version — do not skip it.
- **Negative (authorization)**: in a channel the bot *can* see but that was never `/channel enable`d, the commands may still appear in the picker, but invoking one must produce only an ephemeral refusal — the bot does nothing. This is what proves `/channel` (§2), not visibility, is the real boundary.
- **Obfuscation regression check**: remove the bot from a work channel, confirm it disappears from `GET /guilds/{guild.id}/channels` for that app and that any cached channel list in this bot's own logs/state shows the placeholder rather than a stale real name; re-add the bot and confirm the channel reappears with real data.

**Only the negative tests prove the thing you actually wanted.**

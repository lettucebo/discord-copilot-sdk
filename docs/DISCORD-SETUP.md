# Discord Bot Setup

> **English** · [繁體中文](DISCORD-SETUP.zh-TW.md)

Create the bot, enable the right intent, invite it with the right permissions, and collect the four IDs `.env` needs.

> This covers the **Discord side** only. When you're done, go back to [`INSTALL.md`](../INSTALL.md).

You will end up with these four values:

```env
DISCORD_BOT_TOKEN=          # step 3
DISCORD_ALLOWED_USER_IDS=   # step 5 — your own user ID
DISCORD_GUILD_ID=           # step 5 — server ID
DISCORD_PARENT_CHANNEL_ID=  # step 5 — seed default (first-run) work channel ID
```

---

## 0. Start with a private server

Discord → **+** on the left → **Create My Own** → **For me and my friends**.

Create a **text channel** in it (for example `#copilot`) to act as the **seed default** work channel — its first-run default. Each session becomes a thread under one enabled work channel; the seed default is the one configured in `.env` for the very first start.

> **Why private**: the bot runs shell commands as you. Anyone who can read a work channel can read the agent's output, including file contents. Input is allow-listed; **output is not**.

> The reverse is worth controlling too: the invite's server-level role can read public channels and any private channel that explicitly includes it. §4b explains how private-channel membership confines the bot to its work channels; [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md) explains the separate command-visibility and `/channel` authorization model.

### Recommended: make each work channel private too

A private *server* keeps strangers out entirely, but its ordinary public channels remain visible to every server member, including the bot. The primary, native way to keep the bot's commands from cluttering every channel's `/` picker is to make each **work channel** private — Discord permissions, not this bot's own configuration — and add only this bot's application (plus the humans who use it) as members. See [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md#3-primary-model--private-work-channels-the-recommended-way-to-hide-the-bot) for the full model and rationale.

**Running more than one instance in the same server** (for example a production app and a separate test app): create a **separate Discord application per instance**, each with its own bot user, and add each application's bot **only** to the channel(s) it should own. Two applications never share a member set, so their commands never double up in the same channel's picker — this is the fix for the "duplicate `/new`" problem described in [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md#6-duplicate-commands-from-a-second-app).

---

## 1. Create the application and bot

1. Go to <https://discord.com/developers/applications> → **New Application** → name it. This is the name shown in Discord.
2. Open the **Bot** tab. Newer portals create the bot automatically; otherwise click **Add Bot**.

---

## 2. ⚠️ Enable the Message Content Intent (the #1 gotcha)

**Bot** tab → **Privileged Gateway Intents** → turn on **MESSAGE CONTENT INTENT** → **Save Changes**.

The bot connects with three intents (`src/app.ts`): `Guilds`, `GuildMessages`, `MessageContent`. The first two are free; **`MessageContent` is privileged and must be toggled on here**.

If it is off: the bot shows online and slash commands work, but **it silently ignores everything you type in a thread** — it receives the message event with empty content.

> The other two privileged intents (Presence, Server Members) are **not** needed.

### While you are here: turn OFF "Public Bot"

In the same **Bot** tab, scroll to **PUBLIC BOT** and turn it **off**. Left on (it is on by default), anyone who knows your application ID can invite **your bot** into **their own** server.

This is not a hole: `DISCORD_GUILD_ID` is matched exactly so another guild is refused outright, and slash commands are registered per-guild. But there is no reason to let it be invited anywhere, and an application ID is not a secret.

#### You will hit this error first

```text
Private application cannot have a default authorization link.
Please check that the default authorization link is set to None in the installation tab.
```

Discord refuses to make an app private while it still advertises an install link, so the order is inverted:

1. **Installation** tab → **Install Link** → choose `None` → **Save Changes**.
2. **Bot** tab → turn **PUBLIC BOT** off → click **Save Changes** again.

> Each tab has its **own** save. Seeing `None` in the dropdown does not mean it is saved — a **Save Changes** bar appears and must be clicked.

Removing the install link does **not** affect a bot already in your server: slash commands are registered by the bot itself over the API at startup, not through the install flow. To re-invite later, use the URL in §4.

### Optional: test Channel Obfuscation early

Discord is rolling out a breaking Gateway change — obfuscating channels the bot cannot see — that becomes **mandatory for all bots on 2026-11-16** (see [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md#8-channel-obfuscation-2026-08-12-change-mandatory-2026-11-16) for the full mechanics). You do not need to do anything to comply — the bot's code must already treat any channel named `"___hidden___"` as opaque — but you can opt this application into the new Gateway behavior **now**, ahead of the deadline, to test it: **Bot** tab → **Overview** → **Private Channel Obfuscation** toggle. This is Gateway-only and temporary as an early-access switch; there is no equivalent early opt-in for the HTTP API, which will simply start omitting hidden channels once the change reaches your app.

---

## 3. Copy the bot token

**Bot** tab → **Reset Token** → copy it. **It is shown only once.**

- Treat it as a password: whoever holds it *is* the bot.
- **Never** commit it. `.env` is already in `.gitignore`, and the installer refuses to write a tracked `.env`.
- If it leaks, come back here and **Reset Token**; the old one dies immediately.

---

## 4. Invite the bot

Replace `YOUR_APP_ID` below with the **Application ID** from the **General Information** tab.

Choose the invite mask that matches the host platform:

- **Windows normal:** `326417632256`
- **Non-Windows normal:** `326417599488`
- **Windows lean:** `309237763072`
- **Non-Windows lean:** `309237730304`

Windows needs `Attach Files` because outbound Discord file delivery is available there. Non-Windows can omit `Attach Files` because outbound delivery is unavailable on that platform.

### Windows normal invite

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=326417632256
```

Open it in a browser → pick your server → **Authorize**.

### What that number is

`permissions=326417632256` is exactly the set below. The integer was verified against the Discord API: it round-trips to precisely these permissions, no more.

> **Platform availability:** Outbound Discord file delivery is available only on Windows. Linux, macOS, and other hosts run sessions normally but deliberately expose neither `/file` delivery nor `discord_send_file`, so **Attach Files** is not needed for this bot there.

| Permission | Why |
| --- | --- |
| View Channel | See the work channel. |
| Send Messages | Conventionally granted; this bot's own messages go **only into threads**. Parent-channel replies are ephemeral interaction responses. If you want to trim further, this is the first one to try removing. |
| Attach Files | On Windows, required for deliberate `/file` uploads and agent-proposed `discord_send_file` approvals; without it, file delivery fails even when the thread itself works. |
| Embed Links | Approval cards are embeds. |
| Read Message History | Edit its own earlier messages while streaming. |
| Create Public Threads | `/new` opens a thread. |
| Send Messages in Threads | **Talk in threads**. `Send Messages` has no effect there. |
| Manage Threads | One job only: deleting the empty thread left by a failed `/new`. |

**Already invited the bot?** If you used an older install link, the bot role does **not** gain `Attach Files` until you re-authorize the application (or grant the channel permission manually). Existing threads keep working for text, but `/file` and approved file sends will fail until that permission is added.

### Non-Windows normal invite

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=326417599488
```

This is the same normal invite set without `Attach Files`, because non-Windows cannot deliver outbound Discord files.

**Want to grant less**:

- **Windows lean:** drop `Manage Threads` and use `permissions=309237763072`.
- **Non-Windows lean:** drop `Manage Threads` from the non-Windows set and use `permissions=309237730304`.

Everything still works; the **only** behavior difference versus the corresponding normal mask is that a failed `/new` leaves an empty thread for you to delete.

> Renaming threads (auto-title and `/rename`) does **not** need `Manage Threads` — Discord lets a thread's creator rename it, and the bot is the creator.

Both scopes are required: `bot` for the bot user, `applications.commands` so it can register `/new`, `/stop`, and the rest.

---

## 4b. 🔒 Confine what the bot can read

The invite above grants permissions on the **role**, and role permissions apply **server-wide** — the bot can read **every** channel, including private ones, unless a channel's own membership says otherwise. For a tool that feeds what it reads into Copilot, that is worth tightening.

> **Correction (updated with 2026-08-12 evidence):** an earlier version of this guide claimed that denying the bot `View Channel` confines only what the bot can **read**, with no effect on whether its slash commands appear in that channel's `/` picker. **That claim was wrong and is retracted.** A bot without `View Channel` access to a channel does not have its commands shown there either ([Discord Slash Commands FAQ](https://support-dev.discord.com/hc/en-us/articles/frequently-asked-questions); [Command Permissions](https://support.discord.com/hc/en-us/articles/9349445088791-Command-Permissions-FAQ)). That means the private-channel setup below gives you **both** effects — read-confinement and command-visibility whitelisting — from the same channel membership; see [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md#4-correcting-a-stale-claim-bot-view_channel-does-affect-command-visibility) for the evidence level and how this relates to the primary private-channel model described in [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md#3-primary-model--private-work-channels-the-recommended-way-to-hide-the-bot). The one thing that remains true regardless: Discord can still deliver the underlying `INTERACTION_CREATE` payload to the bot's backend (for example from a client's stale cached command list), and an initial interaction response does not require `SEND_MESSAGES` ([Discord docs](https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction)) — so the bot's own `/channel` authorization check, not this permission screen, remains the actual security boundary.

### Why removing role permissions is not enough

On most servers the `@everyone` role already grants **View Channels**, and a bot is a member like any other, so it **inherits that**. Clearing the bot role's permissions to `0` therefore changes nothing on its own — this is exactly why the procedure below acts on **channel membership**, not on the bot's role.

Check yours in Server Settings → Roles → `@everyone` → whether View Channels is on:

| Where | Effect |
| --- | --- |
| Role, server level grants View Channels | Sees **every** channel that does not explicitly deny it. |
| Channel-level **Allow** for View Channels | Adds **that one** channel. |
| Channel-level **Deny** for View Channels | **Blocks** that channel, taking precedence over the `@everyone` server-level allow. |

Resolution order is: `@everyone` server → role server → `@everyone` channel overwrite → **role channel overwrite**. A private channel's own `@everyone` channel-level deny is what actually blocks reads — that is the mechanism the steps below rely on.

### The setup that works: make each work channel private

| Where | What |
| --- | --- |
| Bot role | **Clear it completely (`0`)**, including Administrator. |
| Each work channel | Make it **private** — remove `@everyone`'s View Channel (or create the channel as private from the start) — then add **only** the bot's application and the humans who should use it as explicit members, with the work-permission set below. |

This is deliberately **membership**, not a per-channel deny list: you never have to visit every *other* channel or category in the server. A channel the bot was never added to already keeps it out, for the same reason §3 of [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md#3-primary-model--private-work-channels-the-recommended-way-to-hide-the-bot) gives for command visibility.

### Steps

1. **Each work channel** → make it private (or create it as private) → Edit Channel → Permissions → add your bot's application and the humans who should use it as members → allow the set for its host:
   - **Windows:** View Channels · Send Messages · Send Messages in Threads · Create Public Threads ·
     Create Private Threads · Manage Threads · Embed Links · Attach Files ·
     Read Message History · Add Reactions · Use External Emoji
     The Windows integer is `395137371200`.
   - **Non-Windows:** the same set without `Attach Files`: View Channels · Send Messages ·
     Send Messages in Threads · Create Public Threads · Create Private Threads · Manage Threads ·
     Embed Links · Read Message History · Add Reactions · Use External Emoji
     The non-Windows integer is `395137338432`.
   Because this scope is limited to channels the bot is an explicit member of, either platform-specific set can be a little wider than its invite set.
2. Server Settings → Roles → your bot role → turn **Administrator** off and leave the rest empty. The **Clear permissions** button in the upper-right can clear the page at once. Humans, not the bot, configure this visibility — there is no ordering requirement between this step and step 1.

> **Make sure you are editing the right role.** A server can carry several integration roles; the edit pane's title must show **your bot's** name.

> **This step is UI-only.** A bot cannot edit its own highest role: Discord's hierarchy rule is not bypassed by `ADMINISTRATOR` (the API returns `50013 Missing Permissions`).

### Deliberately withheld

| Permission | Why withheld |
| --- | --- |
| `Administrator` | Bypasses **all** channel settings, which defeats the isolation above. |
| `Manage Messages` | The program only deletes **its own** messages, which does not require this permission; granting it would let the bot delete yours. |
| `Manage Channels` / `Manage Roles` | Deliberately **not granted** — humans configure channel/member visibility; the bot never needs to and must not edit its own visibility permissions. |
| `Mention Everyone` | Not used. |

### Verify

Do not trust the settings screen; test it:

1. **Positive**: in an enabled work channel, run `/new`, send a message in the thread → it should reply.
2. **Negative**: in a channel the bot was never added to, mention or tag the bot → it should not read or respond to that message. This proves message-read confinement; slash-command visibility and interaction delivery are verified separately in [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md).

Discord does not expose a true "view as bot" channel list, but the member list is a useful signal: the bot should appear only in the work channels' member lists.

---

## 4c. Command permission defaults: `default_member_permissions="0"`

Every command this bot registers is created with `default_member_permissions="0"`. Per Discord's own semantics for that field, this means **nobody in the guild can use the command by default** unless they hold the guild's Administrator permission, or have an explicit per-user/per-role override added in Server Settings → Integrations → the app → Command permissions ([Discord docs](https://docs.discord.com/developers/interactions/application-commands#permissions)).

This is on purpose: combined with the private-channel model above, it means a channel the bot is visible in still won't let an unintended guild member invoke its commands just because they happen to have access to that channel.

**The catch:** the bot's own `isAuthorized` allow-list (`DISCORD_ALLOWED_USER_IDS`) never required its members to be guild Administrators — it is a separate authorization plane (see [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md)). If one of your allow-listed users is **not** a guild Administrator, `default_member_permissions="0"` will stop them from invoking any command at all, even in a work channel they can see, until an override is added for them in Integrations. The bot prints a startup warning naming any allow-listed user detected in this situation, with the exact escape hatch: add that user (or a role they hold) as an explicit allow in Integrations → Command permissions for this app.

The guild **owner** is treated as implicitly satisfying this check (owners always have effective Administrator rights), so a normal single-owner setup does not trigger the warning.

---

## 5. Collect the four IDs

Turn on **User Settings → Advanced → Developer Mode** first.

| Field | How |
| --- | --- |
| `DISCORD_GUILD_ID` | Right-click the server icon → **Copy Server ID**. |
| `DISCORD_PARENT_CHANNEL_ID` | Right-click your **seed default** text channel → **Copy Channel ID**. This is the channel automatically authorized the first time the bot ever starts (its first-run default) — not the only channel the bot can use, and not permanently protected from `/channel disable` once nothing needs it. |
| `DISCORD_ALLOWED_USER_IDS` | Right-click **your own name** → **Copy User ID**. |
| `DISCORD_BOT_TOKEN` | From §3. |

- The seed default channel must be a **text channel** (not a category, forum, announcement, voice channel, or thread); the bot checks this.
- `DISCORD_ALLOWED_USER_IDS` is comma-separated, but v1 should be **just you**. Anyone not listed cannot drive the bot even in an enabled channel.

### Moving to a different parent channel later

The bot now supports multiple work channels. `DISCORD_PARENT_CHANNEL_ID` is only a **seed default**: the channel automatically authorized the very first time this bot instance ever starts, so there is at least one usable channel out of the box. After that first run, it is recorded in the channel registry exactly like a channel added later with `/channel enable` — an ordinary enabled-channel record, not a permanent, undisableable special case — and editing `.env` afterwards has **no effect** on already-persisted authorization, because the registry, once written, is authoritative. Additional or replacement work channels are managed at runtime with `/channel enable` / `/channel disable`; see [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md).

To replace the seed default with a different work channel on an existing install:

1. Make the new channel private, add the bot and intended humans, and grant its complete work-permission set per §4b.
2. **While the old channel is still enabled**, run `/channel enable channel:<new-id>` from it (or `/channel enable` in the new channel), then verify the new entry with `/channel list`.
3. `/end` every session still pointing at the old channel, run `/channel disable` for it, then remove the bot's membership/overwrite from the old channel.

Editing `DISCORD_PARENT_CHANNEL_ID` in `.env` at this point only matters for a **fresh install** that has never written a channel registry file yet — it does not retroactively re-seed or re-authorize anything for an install that has already started once. Sessions that get disabled out from under them do not disappear on their own: startup lists the stranded records, and `/end thread:<id>` clears each one along with its worktree.

---

## 6. Verify

After installing and starting per [`INSTALL.md`](../INSTALL.md):

1. The bot shows **online** in the member list.
2. Typing `/` in the seed default channel lists `/new`, `/stop`, `/usage`, and the rest.
3. `/channel list` reports the seed default as enabled and visible, with no unexpected visibility drift.
4. `/new` opens a new thread.
5. Type "hello" in the thread → **you get a reply**. No reply means the §2 intent is off.

### Verify the private-channel setup from §4b

A settings screen that looks right is **not** proof: effective permissions are computed across four layers. Test the real thing:

1. **Positive**: in an enabled work channel, `/new` → thread opens → typing gets a reply. This proves the private-channel membership works.
2. **Read-confinement negative**: in a channel the bot was never added to, mention the bot → it should not read or respond to that message. This proves the confinement works for messages.
3. **Command-access negative**: in a channel you did not enable, `/` should not list the commands. If it still does, the Discord-plane integration setting is missing; see [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md).

The negative checks are the point. Testing only the first proves it works, not that it is confined.

---

## 7. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Bot is online but ignores thread messages | **Message Content Intent is off** (§2). |
| No slash commands after typing `/` | Missing `applications.commands` scope; re-invite with the §4 URL. If commands appear in the wrong channels, configure Server Settings → Integrations per [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md). |
| `/new` says Missing Permissions | Missing `Create Public Threads`, or a channel-level overwrite blocks the bot. |
| Thread opens but the bot is mute in it | Missing `Send Messages in Threads`; `Send Messages` does not apply to threads. |
| Command replies `Not authorized` | `DISCORD_ALLOWED_USER_IDS` does not contain your user ID. |
| Commands appear only in some servers | Commands are registered to the one `DISCORD_GUILD_ID`. |
| The bot vanished after locking it down | Add the bot back as an explicit member of each work channel and grant View Channel per §4b. Do **not** re-enable Administrator. |
| Changing `DISCORD_PARENT_CHANNEL_ID` did not move the bot to another channel | Expected after the first start: the durable channel registry is authoritative. Add the bot to the new private channel, use `/channel enable`, then retire the old entry with `/channel disable` after ending its sessions. |

---

## 8. Installing on a second computer

Do **not** run the same token on two machines at once.

The bot's single-instance guard is a **local** PID lock and cannot see other hosts (`src/core/single-instance.ts`). Verified: with two instances connected, `/new` is picked up by **one** of them — and not consistently the same one (two runs, two different winners). Since each machine has its own `REPOS_ROOT` and its own approval rules, you cannot predict which machine ran your command or which repo it touched.

To move:

1. Stop the old machine first: close the program, or run `schtasks /End /TN discord-copilot-sdk-default`.
2. Install on the new machine with the **same** four values per [`INSTALL.md`](../INSTALL.md).
3. To keep both machines, give each its **own Discord application**: own token and own seed default work channels. Do not share one token.

> State under `~/.discord-copilot-sdk/` (resumable sessions, channel registry, remembered approvals) is **per machine** and does not follow you. A new machine starts clean, deliberately: approval grants and channel authorization should not silently travel to another host.

---

## 9. Concurrent sessions

**Yes, they run in parallel.** Each `/new` thread is its own session, and by default each gets its **own git worktree** (branch `copilot/t-<threadId>`, under `~/.discord-copilot-sdk-worktrees/`), so two agents editing files at the same time do not clobber each other.

> This prevents *accidental* clobbering; it is not a sandbox. Tools run unsandboxed as your OS user, so a deliberately steered agent can still reach another worktree by path.

| Command | Purpose |
| --- | --- |
| `/new` | Start another concurrent session. It ends nothing. |
| `/sessions` | List live sessions, splitting leftovers into *clearable* and *will retry on restart*. |
| `/end` | End **this** thread's session — or reap its stale record and worktree when none is live. |
| `/end thread:<id>` | Reap a leftover whose thread is gone, from an enabled work channel. |

Up to 8 sessions can run at once.

`/end` removes the worktree **only when git reports it clean**. Ignored files count as content too; anything local is kept and its path reported. `/diff` shows **this thread's own** worktree.

### `/repo` — which repo a thread works in, and how

| Command | What it does |
| --- | --- |
| `/repo show` | Show this thread's repo, mode, branch, and full working directory. |
| `/repo list` | List bindable repos under `REPOS_ROOT`, marking any held in local mode. |
| `/repo set <name>` | Rebind this thread; type to search. |
| `/repo dev <worktree\|local>` | Switch dev mode. |
| `/repo clone <source> [name]` | Clone into `REPOS_ROOT`, then bind. |
| `/repo new <name>` | Create an empty repo under `REPOS_ROOT`, then bind. |

**Every new session gets its own worktree.** `local` — the agent editing the repo checkout directly — is reachable only through a per-thread `/repo dev local`. There is deliberately no config key that makes it the default: that would opt every future thread into editing your working copy without anyone deciding to.

At most **one live `local` session per repo**, within a single bot process (two instances deliberately sharing one `REPOS_ROOT` cannot see each other's leases): two agents in one checkout silently overwrite each other, and a `git checkout` in one destroys the other's uncommitted work. A second thread asking for the same repo is refused and told which thread holds it. Worktree sessions have no such limit.

Rebinding builds a **new** Copilot session (the SDK fixes the working directory at creation), so the conversation history is lost and a thread that has already run a turn must confirm first. A rebind is refused while a turn is running, and while the current worktree holds uncommitted, untracked, or ignored content — after a rebind nothing points at that tree any more.

`/repo clone` fetches only over `https`/`ssh`, only from `github.com` unless `REPO_CLONE_HOST_POLICY=allowlist`, and never from an internal, loopback, or metadata address. git runs with an argv array (never a shell), with `ext::`, `file::`, and credential helpers disabled, and with your global git and ssh config ignored — `url.<base>.insteadOf` rewrites URLs and an ssh `ProxyCommand` runs a program. There is deliberately no "any public host" option: a hostname cannot prove where DNS will point.

> Inside a worktree the agent sees the whole repo (shared git objects) but only its own working files. To land the work, ask the agent to commit in that thread, then `git merge copilot/t-<threadId>` in the main repo.

For concurrency *inside* one session see §10.

---

## 10. Steering and queueing inside one session

- Send a message **while a turn is running** → steers the current turn.
- `/queue message:…` → queues a prompt to run after the current turn.

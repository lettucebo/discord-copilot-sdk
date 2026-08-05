# Discord Bot Setup

> **English** · [繁體中文](DISCORD-SETUP.zh-TW.md)

Create the bot, enable the right intent, invite it with the right permissions, and collect the four IDs `.env` needs.

> This covers the **Discord side** only. When you're done, go back to [`INSTALL.md`](../INSTALL.md).

You will end up with these four values:

```env
DISCORD_BOT_TOKEN=          # step 3
DISCORD_ALLOWED_USER_IDS=   # step 5 — your own user ID
DISCORD_GUILD_ID=           # step 5 — server ID
DISCORD_PARENT_CHANNEL_ID=  # step 5 — seed/primary work channel ID
```

---

## 0. Start with a private server

Discord → **+** on the left → **Create My Own** → **For me and my friends**.

Create a **text channel** in it (for example `#copilot`) to act as the seed/primary work channel. Each session becomes a thread under one enabled work channel; the seed is the first one configured in `.env`.

> **Why private**: the bot runs shell commands as you. Anyone who can read a work channel can read the agent's output, including file contents. Input is allow-listed; **output is not**.

> The reverse is worth controlling too: by default **the bot can read every channel in your server**. §4b explains how to confine what it can read; [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md) explains the separate command-visibility and `/channel` authorization model.

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

---

## 3. Copy the bot token

**Bot** tab → **Reset Token** → copy it. **It is shown only once.**

- Treat it as a password: whoever holds it *is* the bot.
- **Never** commit it. `.env` is already in `.gitignore`, and the installer refuses to write a tracked `.env`.
- If it leaks, come back here and **Reset Token**; the old one dies immediately.

---

## 4. Invite the bot

Replace `YOUR_APP_ID` below with the **Application ID** from the **General Information** tab:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=326417599488
```

Open it in a browser → pick your server → **Authorize**.

### What that number is

`permissions=326417599488` is exactly the set below. The integer was verified against the Discord API: it round-trips to precisely these permissions, no more.

| Permission | Why |
| --- | --- |
| View Channel | See the work channel. |
| Send Messages | Conventionally granted; this bot's own messages go **only into threads**. Parent-channel replies are ephemeral interaction responses. If you want to trim further, this is the first one to try removing. |
| Embed Links | Approval cards are embeds. |
| Read Message History | Edit its own earlier messages while streaming. |
| Create Public Threads | `/new` opens a thread. |
| Send Messages in Threads | **Talk in threads**. `Send Messages` has no effect there. |
| Manage Threads | One job only: deleting the empty thread left by a failed `/new`. |

**Want to grant less**: drop `Manage Threads` and use `permissions=309237730304`. Everything still works; the **only** difference is that a failed `/new` leaves an empty thread for you to delete.

> Renaming threads (auto-title and `/rename`) does **not** need `Manage Threads` — Discord lets a thread's creator rename it, and the bot is the creator.

Both scopes are required: `bot` for the bot user, `applications.commands` so it can register `/new`, `/stop`, and the rest.

---

## 4b. 🔒 Confine what the bot can read

The invite above grants permissions on the **role**, and role permissions apply **server-wide** — the bot can read **every** channel, including private ones. For a tool that feeds what it reads into Copilot, that is worth tightening.

> **Important correction:** denying the bot `View Channel` confines what the bot can **read**, but it does **not** hide the bot's slash commands from the `/` picker and does **not** stop Discord from delivering `INTERACTION_CREATE` events from other channels. Command visibility is controlled by the user's `USE_APPLICATION_COMMANDS` permission plus Application Command Permissions v2 ([Discord docs](https://docs.discord.com/developers/interactions/application-commands#application-command-permissions-object-using-default-permissions)), and interaction delivery is separate from channel send/read permissions ([Discord docs](https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction)). Use [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md) for that separate admin-controlled plane.

### Why removing role permissions is not enough

On most servers the `@everyone` role already grants **View Channels**, and a bot is a member like any other, so it **inherits that**. Clearing the bot role's permissions to `0` therefore changes nothing on its own.

Check yours in Server Settings → Roles → `@everyone` → whether View Channels is on:

| Where | Effect |
| --- | --- |
| Role, server level grants View Channels | Sees **every** channel that does not explicitly deny it. |
| Channel-level **Allow** for View Channels | Adds **that one** channel. |
| Channel-level **Deny** for View Channels | **Blocks** that channel, taking precedence over the `@everyone` server-level allow. |

Resolution order is: `@everyone` server → role server → `@everyone` channel overwrite → **role channel overwrite**. A role-level channel DENY therefore overrides the `@everyone` server-level allow — that is the only thing that actually blocks reads.

### The setup that works

| Where | What |
| --- | --- |
| Bot role | **Clear it completely (`0`)**, including Administrator. |
| Work channels | **Allow** the work-permission set below. |
| Every other channel and category | **Deny** View Channels. |

Categories matter too: their permissions cascade to the channels inside them.

### ⚠️ Order matters

**Do the channel overwrites first, remove Administrator last.** Reversed, the bot loses `Manage Roles` and can no longer edit channel permissions at all.

### Steps

1. **Each work channel** → Edit Channel → Permissions → add your bot role → allow:
   View Channels · Send Messages · Send Messages in Threads · Create Public Threads ·
   Create Private Threads · Manage Threads · Embed Links · Attach Files ·
   Read Message History · Add Reactions · Use External Emoji
   The integer for this set is `395137371200`. Because the scope is limited to work channels, it can be a little wider than the invite set.
2. **Every other channel and category** → Permissions → add the bot role → **Deny** View Channels.
3. **Last**: Server Settings → Roles → your bot role → turn **Administrator** off and leave the rest empty. The **Clear permissions** button in the upper-right can clear the page at once.

> **Make sure you are editing the right role.** A server can carry several integration roles; the edit pane's title must show **your bot's** name.

> **This step is UI-only.** A bot cannot edit its own highest role: Discord's hierarchy rule is not bypassed by `ADMINISTRATOR` (the API returns `50013 Missing Permissions`).

### Deliberately withheld

| Permission | Why withheld |
| --- | --- |
| `Administrator` | Bypasses **all** channel settings, which defeats the isolation above. |
| `Manage Messages` | The program only deletes **its own** messages, which does not require this permission; granting it would let the bot delete yours. |
| `Manage Channels` / `Manage Roles` | Not used. |
| `Mention Everyone` | Not used. |

### Verify

Do not trust the settings screen; test it:

1. In an enabled work channel, run `/new`, send a message in the thread → it should reply.
2. In a **different** channel, mention or tag the bot → it should not read or respond to that message. This proves message-read confinement only; slash-command visibility and interaction delivery are verified separately in [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md).

Discord does not expose a true "view as bot" channel list, but the member list is a useful signal: the bot should appear only in the work channels' member lists.

---

## 5. Collect the four IDs

Turn on **User Settings → Advanced → Developer Mode** first.

| Field | How |
| --- | --- |
| `DISCORD_GUILD_ID` | Right-click the server icon → **Copy Server ID**. |
| `DISCORD_PARENT_CHANNEL_ID` | Right-click the seed/primary text channel → **Copy Channel ID**. This is the always-enabled seed channel, not the only channel the bot can use. |
| `DISCORD_ALLOWED_USER_IDS` | Right-click **your own name** → **Copy User ID**. |
| `DISCORD_BOT_TOKEN` | From §3. |

- The seed channel must be a **text channel** (not a category, forum, announcement, voice channel, or thread); the bot checks this.
- `DISCORD_ALLOWED_USER_IDS` is comma-separated, but v1 should be **just you**. Anyone not listed cannot drive the bot even in an enabled channel.

### Moving to a different parent channel later

The bot now supports multiple work channels. `DISCORD_PARENT_CHANNEL_ID` is the **seed** channel: it is always enabled, cannot be disabled from Discord, and changing it still requires editing `.env` and restarting. Additional work channels are managed at runtime with `/channel enable`; see [`CHANNEL-ACCESS.md`](CHANNEL-ACCESS.md).

To change the seed itself:

1. Edit `DISCORD_PARENT_CHANNEL_ID` in `.env`.
2. **While the bot still has permission**, set the new channel's allows and the old channel's denies per §4b.
3. Restart the bot (`./stop-bot.ps1` → `./run-bot.ps1`).

Threads under the old seed channel **all stop working**: authorization is bound to enabled work channels, and changing the seed in `.env` removes the old seed from the always-enabled set unless you also enable it with `/channel` before the move. Those records do not disappear on their own — startup lists the stranded records in the new seed channel, and `/end thread:<id>` clears each one along with its worktree.

---

## 6. Verify

After installing and starting per [`INSTALL.md`](../INSTALL.md):

1. The bot shows **online** in the member list.
2. Typing `/` in the seed channel lists `/new`, `/stop`, `/usage`, and the rest.
3. `/new` opens a new thread.
4. Type "hello" in the thread → **you get a reply**. No reply means the §2 intent is off.

### If you locked it down per §4b

A settings screen that looks right is **not** proof: effective permissions are computed across four layers. Test the real thing:

1. **Positive**: in an enabled work channel, `/new` → thread opens → typing gets a reply. This proves the allow set works.
2. **Read-confinement negative**: in a different channel, mention the bot → it should not read or respond to that message. This proves the deny works for messages.
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
| The bot vanished after locking it down | Grant View Channels on each work channel, see §4b; to recover fast, re-enable Administrator. |
| Old threads stopped responding after changing `DISCORD_PARENT_CHANNEL_ID` | Expected: changing the seed can leave old threads outside the enabled channel set. Startup lists stranded records; clear them with `/end thread:<id>`. |

---

## 8. Installing on a second computer

Do **not** run the same token on two machines at once.

The bot's single-instance guard is a **local** PID lock and cannot see other hosts (`src/core/single-instance.ts`). Verified: with two instances connected, `/new` is picked up by **one** of them — and not consistently the same one (two runs, two different winners). Since each machine has its own `REPOS_ROOT` and its own approval rules, you cannot predict which machine ran your command or which repo it touched.

To move:

1. Stop the old machine first: close the program, or run `schtasks /End /TN discord-copilot-sdk-default`.
2. Install on the new machine with the **same** four values per [`INSTALL.md`](../INSTALL.md).
3. To keep both machines, give each its **own Discord application**: own token and own seed/work channels. Do not share one token.

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

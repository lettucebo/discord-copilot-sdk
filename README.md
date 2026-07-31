# discord-copilot-sdk

Control your **local GitHub Copilot** from **Discord** — with the full "GitHub Copilot app"
experience — from anywhere, including your phone.

`discord-copilot-sdk` is a Discord bot that drives the local Copilot engine through the official
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) (JSON-RPC). Each
Discord thread maps to a Copilot session; the bot streams the agent's messages, tool calls and
todo checklists into the thread, and surfaces permission / choice / plan prompts as Discord
**buttons** (plus plain thread messages for free-text answers) that you respond to from any
device. Token usage and the live model/effort/context tier are available on demand via
`/usage`.

> Sibling project to [`seam-acp`](https://github.com/lettucebo/seam-acp): seam-acp bridges
> Discord to multiple agents over the ACP protocol; **discord-copilot-sdk is Copilot-only and
> SDK-native**, giving the fullest, most official Copilot experience (native ask_user,
> plan approval, usage, per-model context up to ~1M via `contextTier: long_context`).

## Status

**Working end-to-end and installable** (`install.ps1` / `install.sh`, see
[`INSTALL.md`](INSTALL.md)). Architecture and phase history in [`docs/PLAN.md`](docs/PLAN.md).
Still lab-only — read the security model below before running it.

### Formerly `discopilot`

The project was renamed to `discord-copilot-sdk`. GitHub redirects the old
repository name, so `git clone https://github.com/lettucebo/discopilot.git` still
works — but only for as long as no new repository takes that name, so prefer the
current URL. (The Discord application itself is still called **DisPilot**; that
name lives in the Discord Developer Portal, not in this repo.)

The old names are **not** honoured as configuration:

| Old | New |
| --- | --- |
| `~/.discopilot` | `~/.discord-copilot-sdk` |
| `DISCOPILOT_*` | `DISCORD_COPILOT_SDK_*` |

If either is found on the host, startup says so and tells you what to move —
rather than silently reading the wrong state or ignoring your settings. Saved
approval rules are deliberately **not** carried across for you: restoring an
"Always (this repo)" grant you'd forgotten about is the one direction this
project doesn't move in. A leftover `DISCOPILOT_*` variable is still stripped
from the agent's environment.

## ⚠️ Security model (read before running)

discord-copilot-sdk v1 is **lab-only**. It runs shell/file tools **as the user that starts the bot**,
against a single controlled repo — there is no sandbox in v1 (the isolated controller/worker
split is deferred). Run it only on a disposable machine/VM you don't mind the agent modifying.

Mitigations that **are** in place:

- **Approve-per-command**: every shell permission is surfaced as a Discord Allow/Deny card;
  Allow is settled only after Discord acknowledges the click, and every other permission kind
  and interactive callback (ask_user / exit-plan / elicitation) **fails closed** (deny/cancel).
- **Repo can't reconfigure the agent**: `enableFileHooks`, `enableConfigDiscovery` and
  `enableSkills` are disabled, so a controlled-repo `.github/hooks` file can't auto-approve
  ("`resolvedByHook`") a command behind your back. `skipCustomInstructions` is also set —
  the SDK loads `AGENTS.md` / `.github/copilot-instructions.md` *regardless* of
  `enableConfigDiscovery`, so without it a repo could still ship standing instructions.
  This stops the agent being **configured** by the repo; it is not a claim that repo
  *content* can't influence it (file contents and tool output still reach the model).
- **Spoofing-resistant cards**: the command is shown escaped (no markdown/code-fence breakout),
  commands containing bidirectional/control characters are auto-denied, and an over-long command
  is auto-denied rather than shown partially.
- **Access gate**: only allow-listed user id(s), in the configured guild + parent channel/threads,
  can drive a session. (This gates *input*; anyone who can read the channel can read *output* — use
  a private channel.) Secrets (`DISCORD_*`/`DISCORD_COPILOT_SDK_*`) are stripped from the agent's runtime env.
  By default the bot can also *read* every channel in the server; confining it to one is a few clicks
  and is written up in [`docs/DISCORD-SETUP.md`](docs/DISCORD-SETUP.md) §4b.

**Known limitation — inherited approvals:** the bot uses your logged-in Copilot (`~/.copilot`), so
any blanket "always allow" approval rules you've saved there apply and would bypass the per-command
Discord prompt. For a true approve-per-command demo, run under an account/home **without** saved
auto-approvals. Full isolation is the deferred controller/worker split.

### ⚡ YOLO mode (`/yolo mode:on`) — opt-in, removes the approval gate

`/yolo mode:on` makes **one thread's session** auto-approve **every** permission request with no
card — including the kinds that normally fail closed (file writes, etc.). It exists for
"just get it done" runs; it is the single deliberate exception to approve-per-command, so:

- it is **per-session** (one thread) and **never persisted** — a restart or session recovery
  resets it to **OFF**, and the recovery notice says so;
- enabling it takes effect **only after Discord acknowledges the warning**, so a failed reply can't
  leave a session silently unguarded;
- every auto-approval posts a compact audit notice (kind + bounded target, never the payload).
  The notice is **best effort**: it is never awaited on the approval path, so a Discord outage
  delays or drops the line rather than blocking the tool — do not treat the thread as a
  guaranteed-complete audit log;
- an approval card that was **already waiting** still needs your decision;
- `ask_user` and exit-plan still ask — YOLO approves *permissions*, it does not answer questions or
  pick plan actions;
- `/stop` still wins: teardown fails closed regardless of YOLO;
- `/usage` shows `⚡ YOLO: ON` so you can tell at a glance. Turn it off with `/yolo mode:off`.

## Why the SDK (verified)

Empirically confirmed on a real machine (Copilot Enterprise, copilot CLI 1.0.74-1):

- Drives a **local** session end-to-end: `listModels()`, `createSession()`, `send()`, full
  event stream (`assistant.message`/`reasoning`/deltas, `tool.execution_*`,
  `session.usage_info`/`plan_changed`/`idle`). discord-copilot-sdk renders assistant messages and
  tool calls; reasoning is intentionally **not** rendered into the thread.
- Native interactive callbacks: `onPermissionRequest`, `onUserInputRequest` (ask_user),
  `onExitPlanMode`, `onElicitationRequest`.
- **`contextTier: "long_context"` unlocks a 936K effective window** (200K default) — something
  the raw ACP path could not do (capped at 264K).

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- GitHub Copilot CLI installed and signed in on the host (the bot uses the logged-in user)
- A Discord bot token; your Discord user id on the allow-list

## Quick start

One line, no clone needed — ensures git, fetches the source, runs the bilingual
wizard.

```powershell
irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
```

Append `-Residency24x7` / `--residency-24x7` to also install **true 24/7**
residency (starts at boot, no login required). On Windows that means the
Scheduled Task has to hold your account password — not because Copilot cannot
authenticate headlessly (the SDK does expose `gitHubToken`; this app hardcodes
`useLoggedInUser: true`), but because the agent edits files in your repo and
worktrees as **you**, and running as a user with nobody logged in is what Windows
charges a stored password for. If you only need "keep running while I'm away",
plain `-Residency` plus a locked screen costs nothing and stores no secret. See
the residency section of [`INSTALL.md`](INSTALL.md).

Full instructions are in [`INSTALL.md`](INSTALL.md). Setting up the Discord bot itself —
application, the required Message Content intent, invite permissions, and the
four IDs — is in [`docs/DISCORD-SETUP.md`](docs/DISCORD-SETUP.md).

From an existing clone:

```bash
cp .env.example .env   # fill in DISCORD_BOT_TOKEN + DISCORD_ALLOWED_USER_IDS
npm install
npm run dev
```

Or, once configured, `./run-bot.ps1` / `./run-bot.sh` to start it detached and
`./stop-bot.ps1` / `./stop-bot.sh` to stop it.

## Uninstall

```powershell
./uninstall.ps1 -DryRun   # see exactly what would go, change nothing
./uninstall.ps1           # show the plan, ask, then remove everything
```

```bash
./uninstall.sh --dry-run
./uninstall.sh
```

It removes the residency registration, the running bot, the guild's slash
commands, the per-session worktrees, `~/.discord-copilot-sdk` (approval grants,
session records, logs, `.env` backups) and `.env` **including your bot token**.

It never deletes your controlled repo, never touches `~/.copilot` (your Copilot
CLI login), never removes a worktree git cannot prove is clean, and keeps
`copilot/t-*` branches unless you pass `--branches` — and even then only the
merged ones. `--keep-config` keeps `.env`, and says plainly that your token is
still on disk. Details in [`INSTALL.md`](INSTALL.md).

## Threads

Each `/new` opens a thread. Its name is generated from your first message by a
small, cheap model (`gemini-3.5-flash` by default) running in a **throwaway
session with no tools**, so a long first prompt still becomes a short, readable
name and your own session's history/context is never touched. `/rename title:…`
overrides it; `TITLE_MODEL=off` disables the titler and falls back to a
truncated first line.

There is deliberately no `#001` ordinal: Discord already orders a channel's
threads by creation (verified on the desktop client — posting the newest message
into an older thread does not move it above a newer one), so a number would only
consume sidebar width.

## Concurrent sessions

Every `/new` thread is an independent session and they run **in parallel**. Each
gets its own **git worktree** (branch `copilot/t-<threadId>`), so two agents
working at the same time do not overwrite each other's files — verified by
running two threads at once and confirming each wrote only into its own tree
while the controlled repo stayed untouched.

> The isolation is against *accidental* clobbering, not a sandbox. Lab mode runs
> tools unsandboxed as your OS user, so a session that is deliberately steered
> (e.g. by prompt injection from repo content) can still reach another session's
> worktree by path. Everything in the security model above still applies.

- `/sessions` — what's live, with each one's state and branch (max 8). Leftover
  records are listed too, split by what can actually be done with them:
  *clearable*, or *will retry on restart* (never deleted — the record is the only
  pointer to that Copilot conversation).
- `/end` — end **this** thread's session; the others keep running. In a thread
  whose session is gone but whose record survived, the same command reaps that
  record and its worktree.
- `/end thread:<id>` — the commonest leftover is a **deleted** thread, which you
  cannot type inside. Run this from the parent channel instead; the bot also
  posts the ids there at startup, along with any worktree directory that has no
  record at all. A worktree is removed only when git proves it safe — any local
  content, a detached HEAD, or a HEAD on a different branch keeps it, **and the
  record is kept with it** so `/sessions` still shows the disk. Deal with the
  tree (`git worktree remove`) and run the same command again to finish.

`/end` removes the worktree **only when git reports it clean**. A dirty one is
kept and its path reported: uncommitted work is not ours to discard. To land a
session's work, ask it to commit, then `git merge copilot/t-<threadId>`.

`SESSION_ISOLATION` overrides the default: `worktree` forces isolation (and
**refuses to start** where it is impossible, rather than silently downgrading),
`shared` puts every session in the one checkout — which is only safe one at a
time, so `/new` then ends the previous session.

## Steering and queueing

A plain message sent **while a turn is running** *steers* that turn rather than
being dropped. It is delivered with the runtime's `mode: "immediate"`, which
lands at the next tool-call boundary — measured: a run of eight sequential
commands stopped after four and followed the new instruction. During a single
long generation there is no boundary to land on, so it runs immediately after
instead; nothing in-flight is thrown away either way.

`/queue message:…` holds a prompt until the current turn finishes, then runs it
(`/queue` alone lists what's pending, `/queue clear:true` empties it). The queue
is kept **inside discord-copilot-sdk**, not handed to the runtime's own queue: an
`abort()` does *not* drain the runtime queue (a queued message still ran after
one), so `/stop` could not have honestly stopped it. As it is, `/stop` drops the
queue and says how many it discarded. The queue is volatile — a restart forgets
it — and capped at 10.

## License

MIT — see [LICENSE](LICENSE).

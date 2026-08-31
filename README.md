# discord-copilot-sdk

> **English** · [繁體中文](README.zh-TW.md)

Control your **local GitHub Copilot** from **Discord** — with the full "GitHub Copilot app"
experience — from anywhere, including your phone.

`discord-copilot-sdk` is a Discord bot that drives the local Copilot engine through the official
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) (JSON-RPC). Each
Discord thread maps to a Copilot session; the bot streams an ordered timeline of the agent's
messages, compact tool calls, collapsed thinking and todo checklists into the thread, and surfaces permission / choice / plan prompts as Discord
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
Contributor CI diagnostics are in [`docs/CI-TROUBLESHOOTING.md`](docs/CI-TROUBLESHOOTING.md).
Why this project exists rather than an off-the-shelf Discord agent bridge, and why ACP-backed
routes are excluded, is recorded in [`docs/HARNESS-EVALUATION.md`](docs/HARNESS-EVALUATION.md).
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
- **Repo hooks, MCP config and custom instructions stay disabled**: `enableFileHooks:false`
  prevents a controlled-repo `.github/hooks` file from auto-approving (`resolvedByHook`) a
  command behind your back. `enableConfigDiscovery:false` prevents `.mcp.json` /
  `.vscode/mcp.json` discovery, and `skipCustomInstructions:true` is still required because
  the SDK loads `AGENTS.md` / `.github/copilot-instructions.md` regardless of config discovery.
- **Skills are an explicit, narrower exception**: by default the bot loads only the CLI-native
  skill roots `.github/skills`, `.agents/skills` and `.claude/skills` from the session repo,
  plus `~/.copilot/skills`. This does **not** enable broad config/MCP discovery, and a skill's
  `allowed-tools` frontmatter was verified not to bypass Discord permission cards in SDK mode.
  However, a skill's name and description enter the model context even before invocation, so
  repo authors can steer the agent. Set `ENABLE_REPO_SKILLS=false` to remove repo skill roots
  while retaining user skills, or `ENABLE_USER_SKILLS=false` to do the reverse.
- **Spoofing-resistant cards**: the command is shown escaped (no markdown/code-fence breakout),
  commands containing bidirectional/control characters are auto-denied, and an over-long command
  is auto-denied rather than shown partially.
- **Access gate**: only allow-listed user id(s), in the configured guild + an enabled channel/threads,
  can drive a session. (This gates *input*; anyone who can read the channel can read *output* — use
  a private channel.) Secrets (`DISCORD_*`/`DISCORD_COPILOT_SDK_*`) are stripped from the agent's runtime env.
  Which channels the bot can *read* is a Discord decision, not this bot's: the invite grants the bot
  baseline permissions (so it can see ordinary public channels), but a **private channel** that only
  this bot's application is added to is Discord's native whitelist — a bot that is not a member of a
  channel receives none of its content, and its slash commands do not appear there either. The
  recommended model is a private work channel; [`docs/CHANNEL-ACCESS.md`](docs/CHANNEL-ACCESS.md) is
  the authoritative model and §4b of [`docs/DISCORD-SETUP.md`](docs/DISCORD-SETUP.md) covers the
  least-privilege permission set. Hiding the slash commands where the bot *is* a member is a separate,
  admin-only Discord Integrations override, also documented in
  [`docs/CHANNEL-ACCESS.md`](docs/CHANNEL-ACCESS.md).

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
- every auto-approval first appends and fsyncs a bounded record (kind + target, never the
  payload) to `~/.discord-copilot-sdk/<instance>.audit.jsonl`, then renders a compact timeline entry.
  A Discord render is best effort, but the on-disk log is authoritative; if it cannot be
  written, YOLO and existing-rule auto-approvals deny that request rather than run without an
  audit trail;
- Already-posted ordinary permission cards are not retroactively changed by YOLO; file-delivery cards are different:
  turning YOLO on immediately revokes any pending `discord_send_file` approval, and later agent file-send requests
  are fast-denied with guidance to use `/file`;
- `ask_user` and exit-plan still ask — YOLO approves *permissions*, it does not answer questions or
  pick plan actions;
- `/stop` still wins: teardown fails closed regardless of YOLO;
- `/usage` shows `⚡ YOLO: ON` so you can tell at a glance. Turn it off with `/yolo mode:off`.
- **Do not combine YOLO with repo skills unless you accept the risk**: repository skill text can
  steer the model and YOLO removes the Discord approval gate that normally constrains tool use.
  The enable warning calls this out whenever the session loaded repo skills.

## Why the SDK (verified)

Empirically confirmed on a real machine (Copilot Enterprise, copilot CLI 1.0.74-1):

- Drives a **local** session end-to-end: `listModels()`, `createSession()`, `send()`, full
  event stream (`assistant.message`/`reasoning`/deltas, `tool.execution_*`,
  `session.usage_info`/`plan_changed`/`idle`). discord-copilot-sdk renders assistant messages,
  compact in-order tool calls, and thinking collapsed behind Discord spoilers. Reasoning markdown
  delimiters are rendered as plain text so they cannot break the spoiler. New sessions request
  detailed reasoning summaries; providers that keep summaries opaque (such as Claude in the
  tested runtime) may still produce no displayable thinking, while GPT reasoning models provide
  visible summaries.
- Native interactive callbacks: `onPermissionRequest`, `onUserInputRequest` (ask_user),
  `onExitPlanMode`, `onElicitationRequest`.
- **`contextTier: "long_context"` unlocks a 936K effective window** (200K default) — something
  the raw ACP path could not do (capped at 264K).

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- GitHub Copilot CLI installed and signed in on the host (the bot uses the logged-in user)
- A Discord bot token, your Discord user id (the allow-list), the guild (server) id, and a private
  text channel id used as the first-run **seed default** (`DISCORD_PARENT_CHANNEL_ID`)

### Skills and source switches

New sessions explicitly load these roots while keeping `enableConfigDiscovery:false`:

| Source | Default | Switch |
| --- | --- | --- |
| Repo: `.github/skills`, `.agents/skills`, `.claude/skills` | on | `ENABLE_REPO_SKILLS` |
| User: `~/.copilot/skills` | on | `ENABLE_USER_SKILLS` |

Both switches accept only lowercase `true` / `false`; an empty `.env` value falls back to
`true`. If no enabled root actually contains a `SKILL.md`, the bot removes the `skill` tool
instead of leaving a tool that can only fail with “Skill not found.” A git worktree sees committed
skills only; use `/repo dev local` while iterating on uncommitted skill files.

`~/.copilot/skills` is shared across sessions. Any session that you approve to run shell commands
can write there, so treat user skills as trusted local state and use a disposable lab host.

After upgrading the local Copilot CLI, run the manual acceptance probe (requires login):

```bash
npm run smoke:skills
```

## Quick start

One line, no clone needed — ensures git, fetches the source (or reuses an
existing checkout, if you're already in one), runs the bilingual wizard.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF)))
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
```

> ⚠️ Do not use `irm ... | iex` on Windows — see [`INSTALL.md`](INSTALL.md) for why it fails outright and cannot take flags either way.

Already sitting in a checkout of this repo? Running it interactively offers to
reuse that directory as-is (never fetches/checks it out — no risk of detaching
your `main`). Pass `-Dir <path>` / `--dir <path>`, or run non-interactively
(`-Yes`/`--yes`), to skip the prompt. See the folder-selection section of
[`INSTALL.md`](INSTALL.md) for details.

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

### File delivery

Use `/file path:<path>` when you deliberately want to upload a validated file from the session's workdir to the owning Discord thread. Agents can also propose `discord_send_file({path,comment?})`, which normally requires its own Allow once / Deny card, is limited to workdir files, and shares the same 8 MiB Discord upload cap. The bot needs Discord's **Attach Files** permission for both paths, and all file sends suppress mentions. YOLO is deliberately different from generic pending cards: enabling it revokes an already-pending file-delivery card and fast-denies later agent file-send requests with a notice to use `/file` instead.

> **Platform availability:** Outbound Discord file delivery is available only on Windows. On Linux, macOS, and other platforms, sessions and every non-file bot feature continue normally, but `/file` safely reports unavailable and `discord_send_file` is not exposed. This is deliberate: the SDK accepts only a pathname `workingDirectory`, not a retained descriptor, so POSIX cannot safely prevent a swap-and-restore during create or resume.

From an existing clone:

```bash
cp .env.example .env   # fill in DISCORD_BOT_TOKEN + DISCORD_ALLOWED_USER_IDS
npm install
npm run dev
```

Or, once configured, `./run-bot.ps1` / `./run-bot.sh` to start it detached and
`./stop-bot.ps1` / `./stop-bot.sh` to stop it.

## Updating

Use the updater instead of re-running the installer. It preserves `.env`, stops
residency before the bot, validates the incoming revision, rebuilds, and restores
the previous running state **only after** setup succeeds.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.ps1).TrimStart([char]0xFEFF)))
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.sh | bash
```

Run it locally for the available safeguards:

```powershell
./update.ps1 -Check                 # read-only; 0=current, 2=differs, 1=preflight refusal
./update.ps1 -DryRun                # full plan, no fetch, stop, build, or write
./update.ps1 -Ref refs/tags/v0.1.0  # pin an annotated or lightweight release tag
./update.ps1 -AllInstances          # explicitly include every live local instance
./update.ps1 -Restore               # restore state kept after a failed apply
```

```bash
./update.sh --check
./update.sh --dry-run
./update.sh --ref refs/tags/v0.1.0
./update.sh --all-instances
./update.sh --restore
```

`--check` is suitable for source monitoring: `0` means HEAD matches the
requested ref, `2` means it differs, and `1` means a fail-closed preflight
refusal needs attention. It is not a runtime health check; the output names the
exact root, checkout, and resolved ref it inspected. A named development branch
updates only by fast-forward when clean; a dirty, divergent, or unknown
checkout is refused before downtime. An update also refuses when another live
instance exists unless `--all-instances` is explicit.

If setup fails after source has changed, the updater deliberately leaves the
bot stopped and retains `~/.discord-copilot-sdk/update-state.<instance>.json`;
fix the reported problem, then run `--restore`. On Windows, stopping a bot is a
hard process termination, so an in-flight turn can be lost. See
[`INSTALL.md`](INSTALL.md) for the detailed lifecycle and release policy.
Until that restore state is resolved, a new apply is refused; `--check` and
`--dry-run` remain available for diagnosis. A successful update reports each
lifecycle phase and only calls a bot restarted after observing its new PID; a
bot that was already stopped stays stopped and is reported as such.

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
  *clearable*, *will retry on restart* (never deleted — the record is the only
  pointer to that Copilot conversation), and records the bot lost channel access to
  (`thread-no-access`), which retry automatically once access is restored — no restart needed —
  but can also be explicitly cleared by the owner with `/end thread:<id>`.
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

### Channel access (`/channel`)

Sessions can live in more than one private Discord channel. `DISCORD_PARENT_CHANNEL_ID` is the first-run **seed default**: it is imported into the channel registry on first run, then behaves like any other removable entry. Add the bot to a private channel first, then use `/channel enable` there or `/channel enable channel:<id>` from an already enabled channel. Use `/channel disable` to remove a channel and `/channel list` to audit authorization against Discord visibility. See [`docs/CHANNEL-ACCESS.md`](docs/CHANNEL-ACCESS.md) for the authoritative model and [`INSTALL.md`](INSTALL.md) for the full private-channel setup, enable, and positive/negative verification workflow.

`/channel list` audits each **enabled** channel's authorization against what the bot can currently see and reports drift (authorized but no longer visible, or visible but never authorized). Whether Discord shows the slash commands in a user's command picker follows from channel membership, with an optional admin-only Integrations override; see [`docs/CHANNEL-ACCESS.md`](docs/CHANNEL-ACCESS.md).

## Repos and dev mode

`REPOS_ROOT` is the folder that **contains** your repos (e.g. `C:\Source\Repos`);
`DEFAULT_REPO` names the one `/new` binds to when you don't pass `repo:`.

- `/repo show` — the repo, mode, branch and **full working directory** of this thread.
- `/repo list` — every bindable repo, marking any held in `local` mode.
- `/repo set <name>` — rebind this thread (type-to-search).
- `/repo dev <worktree|local>` — where this session works.
- `/repo clone <source> [name]` — clone into `REPOS_ROOT`, then bind.
- `/repo new <name>` — create an empty repo there, then bind.

**Every new session gets its own worktree.** `local` — the agent editing the repo
checkout directly — is reachable only through `/repo dev local`, per thread. There
is no config key that makes it the default, because that would opt every future
thread into editing your working copy without anyone deciding to.

At most **one live `local` session per repo** (per bot process). Two agents in one checkout silently
overwrite each other, and a `git checkout` in one destroys the other's uncommitted
work, so a second thread asking for the same repo is refused and told which thread
holds it. Worktree sessions have no such limit — that is what they are for.

Rebinding builds a **new** Copilot session, because the SDK fixes a session's
working directory when it is created. The conversation history is therefore lost,
so a thread that has already run a turn asks for confirmation first. A rebind is
refused outright while a turn is running, and while the current worktree has
uncommitted, untracked or ignored content — after a rebind nothing points at that
tree any more, so orphaning it would put it beyond every command's reach.

`/repo clone` only fetches over `https`/`ssh`, only from `github.com` unless you
set `REPO_CLONE_HOST_POLICY=allowlist`, and never from an internal, loopback or
metadata address. It runs git with an argv array (never a shell), with `ext::`,
`file::` and credential helpers disabled, and with your global git and ssh config
ignored — `url.<base>.insteadOf` can rewrite an allowed URL, and an ssh
`ProxyCommand` can run a program. There is deliberately no "any public host"
option: a hostname cannot prove where DNS will point.

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

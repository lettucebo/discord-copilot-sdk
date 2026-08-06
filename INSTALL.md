# discord-copilot-sdk — Installation Guide

> **English** · [繁體中文](INSTALL.zh-TW.md)

> ⚠️ **LAB-ONLY (v1)**
> discord-copilot-sdk lets Discord drive your local GitHub Copilot: the agent **runs shell commands and edits files as you**, with no isolation in v1. Use **only** on a disposable VM / test account / throwaway repo.

The installer is **bilingual** (Traditional Chinese + English): it defaults to your OS locale and lets you choose.

---

## 1. Prerequisites

- **Node.js** ≥ 20.19 (or ≥ 22.12)
- **git**
- **GitHub Copilot CLI** (`copilot`) — signed in via `copilot` then `/login`
- A Discord bot token, your Discord user ID, the target guild ID, and a parent channel ID (private channel recommended)

> 🤖 **No bot yet?** Start with [`docs/DISCORD-SETUP.md`](docs/DISCORD-SETUP.md) — create the bot, enable the required Message Content Intent, invite it with the right permissions, and collect the four values above.

> The installer can auto-install Node / git / Copilot CLI (winget on Windows, brew on macOS, apt/dnf on Linux).

---

## 2. Fastest: one-line install

No clone needed — this ensures git, fetches the source, and drops you into the wizard.

### Windows (PowerShell)

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF)))
```

> ⚠️ **Do not use `irm ... | iex`.** `get.ps1` ships with a UTF-8 BOM (PowerShell 5.1 needs it to parse the file from disk), and `Invoke-RestMethod` does **not** strip that BOM from the response body on **either** PowerShell 5.1 or 7. `iex` / `[scriptblock]::Create()` parse a raw string, not a file, so the untrimmed BOM lands on the `#Requires` token and the script fails to parse outright (two red errors). `iex` also evaluates in the caller's scope, where a top-level `param()` degenerates into variable declarations, so it cannot take flags either way. The form above — strip the BOM, then invoke the scriptblock — is the only supported form, and it takes flags fine:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF))) -Residency24x7
```

### macOS / Linux (bash)

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash -s -- --residency-24x7
```

### Simpler equivalent

```bash
git clone https://github.com/lettucebo/discord-copilot-sdk.git && cd discord-copilot-sdk && ./install.sh   # or ./install.ps1
```

### For a private fork

If you fork this privately, `raw.githubusercontent.com` returns 404 — use `gh`, which uses your existing GitHub login:

```powershell
& ([scriptblock]::Create(((gh api repos/<owner>/discord-copilot-sdk/contents/get.ps1 -H "Accept: application/vnd.github.raw" | Out-String).TrimStart([char]0xFEFF))))
```

```bash
gh api repos/<owner>/discord-copilot-sdk/contents/get.sh -H "Accept: application/vnd.github.raw" | bash
```

> Neither PowerShell 5.1 nor 7 strips a BOM from native-command output, so both the `irm` and the `gh` form need `.TrimStart([char]0xFEFF)`; `get.ps1` carries a BOM because PowerShell 5.1 needs one when the file is run from disk.

Env overrides: `DISCORD_COPILOT_SDK_DIR` (install location, default `~/discord-copilot-sdk`), `DISCORD_COPILOT_SDK_REF` (branch/tag, default `main`). You can also pass `-Dir <path>` / `--dir <path>` on the command line to set it directly.

### Folder selection

Without `-Dir`/`--dir`/the env var, and in an interactive terminal (no `-Yes`/`--yes`/`-y`), the bootstrapper detects whether your **current directory (or an ancestor) is already a checkout of this repo** and shows a menu:

```
[1] Use existing <path to your current checkout> (default, not updated)
[2] Install to <default path>
[3] Custom path
```

> ⚠️ **Choosing [1] never fetches or checks out** — it hands your existing checkout to the installer exactly as it stands, so it can never accidentally detach HEAD off a branch you're actively developing on (e.g. `main`). Only the default/custom-path options ([2], [3], or `-Dir`/the env var) update via "fetch + checkout latest if already present" — those are directories the bootstrapper itself manages, not your working copy.

A non-interactive run (`-Yes`/`--yes`/`-y`, or no tty — e.g. CI) **never detects or prompts** — it always uses the default path, so scripted invocations behave the same regardless of the caller's cwd.

> Existing checkout → updated in place; a non-empty directory that isn't ours → refused, never overwritten.

---

## 2b. Or get the code manually

```bash
git clone https://github.com/lettucebo/discord-copilot-sdk.git
cd discord-copilot-sdk
```

---

## 3. Run the installer

### Windows (PowerShell)

```powershell
./install.ps1
```

Language flag and options:

```powershell
./install.ps1 -Lang zh        # force Traditional Chinese
./install.ps1 -Lang en        # force English
./install.ps1 -Yes            # non-interactive (uses existing .env/defaults)
./install.ps1 -DryRun         # preview only, no changes
./install.ps1 -Residency      # residency (login-keepalive)
./install.ps1 -Residency24x7  # true 24/7 (stores a Windows password)
./install.ps1 -NoResidency    # skip residency
./install.ps1 -SkipAuth       # skip auth check (marked unverified)
```

### macOS / Linux (bash)

```bash
bash install.sh               # or ./install.sh (if chmod +x already)
bash install.sh --lang zh     # force Traditional Chinese
bash install.sh --lang en     # force English
bash install.sh --yes         # non-interactive
bash install.sh --dry-run     # preview only
bash install.sh --residency   # login/user auto-start
bash install.sh --skip-auth
```

> Do **not** run the installer with `sudo` (only package installs elevate when needed).

> ⚠️ **`REPOS_ROOT` must be an absolute path to the folder that CONTAINS your repos** — e.g. `C:\Source\Repos`, **not** `C:\Source\Repos\my-repo`. This is the exact INVERSE of the old `CONTROLLED_REPO_PATH` rule, which required a path that *was* a repo. The installer rejects a `REPOS_ROOT` that is itself a git repo, because pasting the old value straight in is the commonest upgrade mistake. It must also not contain, or sit inside, `~/.discord-copilot-sdk` — that would put every agent's working directory below the store holding your approval rules. No disposable repo yet? `mkdir -p ~/copilot-sandbox/demo && cd ~/copilot-sandbox/demo && git init`, then set `REPOS_ROOT=~/copilot-sandbox`.

> 🔄 **Upgrading from the single-repo version**: the installer migrates for you — `CONTROLLED_REPO_PATH=C:\Source\Repos\my-repo` becomes `REPOS_ROOT=C:\Source\Repos` plus `DEFAULT_REPO=my-repo`, and the old line is deleted from `.env`. The bot refuses to start while a removed key is still set: those keys used to DEFINE the repo boundary, and its meaning has changed, so leaving them ambiguous is not an option.

> Stop the bot (`./stop-bot.ps1` / `./stop-bot.sh`) before re-running the installer — npm has to replace files a running process holds open. The installer detects this and says so, instead of failing with a cryptic `EPERM`.

The installer will: detect prerequisites → collect + **validate** config → `npm ci` + build → validate the config in memory against the real schema → **finally** write `.env` securely (owner-only, token never echoed, atomic write + backup) → (optional) residency → done report. (Build first, `.env` written last; on a **fresh install** npm never sees the token on disk.)

---

## 3b. Update an existing installation

Use the updater instead of re-running `install.*`. It uses the same shared
configuration/build engine, but first protects the lifecycle ordering that a
manual `git pull && npm install` misses.

### One-line network bootstrap

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.ps1).TrimStart([char]0xFEFF)))
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.sh | bash
```

The network form downloads a fresh updater engine to a private temporary
directory. That engine stops residency and bot processes **before** it changes
the target checkout, so the bootstrap never replaces files held by a live bot.
The updater deliberately trusts only this upstream origin; updating a private
fork is not supported in v1, even if its bootstrap script is fetched through
`gh api`.

### Local commands and guarantees

```powershell
./update.ps1 -Check
./update.ps1 -DryRun
./update.ps1 -Ref refs/tags/v0.1.0
./update.ps1 -AllInstances
./update.ps1 -Restore
```

```bash
./update.sh --check
./update.sh --dry-run
./update.sh --ref refs/tags/v0.1.0
./update.sh --all-instances
./update.sh --restore
```

`--check` performs no writes and exits `0` if the requested ref already equals
HEAD, `2` if it differs, or `1` on a fail-closed preflight refusal (for example,
a dirty checkout or another live instance). `--dry-run` presents the lifecycle
plan without fetch, stop, build, write, or checkout. Short refs prefer a branch
over a same-named tag; use `--ref refs/tags/v0.1.0` to remove ambiguity.
Annotated tags compare their peeled commit, not the tag object.

The updater refuses a dirty or unknown checkout. A named development branch
updates only through `git merge --ff-only`, after proving ancestry; a
bootstrap-managed detached checkout fetches depth-one then detaches at
`FETCH_HEAD`. It scans all live instance locks and requires `--all-instances`
before touching source used by another instance.

The apply sequence is: read-only preflight → stop residency → stop bot → move
source → `setup.mjs --yes --skip-auth --no-residency` → restore. Existing
residency is only re-enabled/restarted; it is never re-registered, so a Windows
24/7 task is not silently downgraded to login-keepalive.

> ⚠️ If setup fails after source changes, the updater intentionally leaves the
> bot stopped, preserves `~/.discord-copilot-sdk/update-state.<instance>.json`,
> and prints the `--restore` command. On Windows stopping is a hard termination,
> so an in-flight turn may be lost. Review active threads/worktrees first and
> confirm the guard (or pass `--yes`) only when that interruption is acceptable.

### Releases

`--version` shows the app SemVer release, commit SHA, and installed Copilot SDK.
`CHANGELOG.md` records release changes and starts at `0.1.0`; it is English-only
by design because each tag creates one GitHub Release. The workflow generates
GitHub Release notes automatically. Prepare `[Unreleased]`, then explicitly run
`npm run release -- <version>` from a clean tree. The helper commits the
version/changelog and creates annotated `v<version>`; push the branch and tag
to publish the release workflow.

---

## 4. Residency — two different things

The installer asks separately. **Login-keepalive is the default**; a password is only involved if you explicitly choose 24/7.

| | login-keepalive (default) | **true 24/7**<br>`-Residency24x7` / `--residency-24x7` |
|---|---|---|
| starts | at your logon | **at boot, no login** |
| after logout | **stops** | keeps running |
| password | no | Windows: **yes** |
| platforms | Windows / macOS / Linux | Windows, Linux (not macOS) |

### Why does 24/7 need a password?

It is **not** because Copilot cannot authenticate with a token — the SDK does expose `gitHubToken`; this app hardcodes `useLoggedInUser: true` (`src/copilot/sdk.ts`). The real reason is **file ownership**: the agent runs commands and edits files in the repos under `REPOS_ROOT` and creates git worktrees under your home directory. Another account would scramble ownership across all of it, and SYSTEM would run arbitrary commands as SYSTEM — worse for a tool whose security note is "the agent runs shell commands as you". Running as a user with nobody logged in is what Windows requires a stored password for.

### Consider this first: stay logged in, lock the screen

If you only need "keep running while I'm away", **login-keepalive plus a locked screen** is enough: no stored secret, no unlocked desktop. The only thing it does not survive is a reboot. Choose 24/7 only when unattended reboots matter.

> The password goes to **Windows Credential Manager** and is **never** written to a file, `.env`, or a command line: the installer reads it with hidden input and passes it through the child process environment, because `schtasks /RP` and `powershell -Command "…$pw…"` both leave secrets in argv where any process can read them via `Win32_Process`. To be honest about the limit: a child environment is **not** a secret channel — a same-user process can still recover it from the PEB via `ReadProcessMemory`, and admins/SYSTEM more easily. It removes the casual exposure, not a determined one.

> After a Windows password change the task's stored credential goes stale and the task fails until you re-run the installer.

> **Non-interactive never escalates**: with `--yes`, in CI, or through a pipe there is no safe way to ask, so `--residency-24x7` falls back to login-keepalive and says so.

> **A corporate-managed or restricted account may simply be denied**: on some enterprise-managed Windows machines (observed with an account listed in Administrators but marked "for deny only"), `Register-ScheduledTask` returns "Access is denied". The installer prints a warning and **still completes the rest of setup** (`.env`/build already succeeded, so this optional step failing does not fail the whole install) — you can still start it manually with `./run-bot.ps1`.

- **Windows**: Scheduled Task `discord-copilot-sdk-<instance>` (auto-restarts on failure, no runtime limit, never starts twice).
  - Stop: `schtasks /End /TN discord-copilot-sdk-default`
  - Remove: `schtasks /Delete /TN discord-copilot-sdk-default /F`
  - Log: `~/.discord-copilot-sdk/logs/discord-copilot-sdk-default.log`
- **Linux**: `~/.config/systemd/user/discord-copilot-sdk-<instance>.service`; 24/7 automatically runs `loginctl enable-linger` (no password).
- **macOS**: login-keepalive only. LaunchAgent binds to login; LaunchDaemon runs as root and makes Copilot logged out — neither can run as you before login, so this guide will not pretend 24/7 is available.
  `~/Library/LaunchAgents/com.discord-copilot-sdk.<instance>.plist`

> macOS/Linux residency is **experimental, not verified on real hardware**.

Multiple deployments: set `DISCORD_COPILOT_SDK_INSTANCE_ID` (default `default`), and residency resource names change with it.

### Start and stop by hand

```powershell
./run-bot.ps1      # start detached (refuses if already running)
./run-bot.ps1 -Foreground
./stop-bot.ps1     # reads the app's own lock
```

```bash
./run-bot.sh
./run-bot.sh --foreground
./stop-bot.sh
```

---

## 5. Final step (manual)

In your Discord channel, run `/new` to start a session, or send a message to test.

---

## 6. Complete uninstall

```powershell
./uninstall.ps1 -DryRun      # plan only, changes nothing
./uninstall.ps1              # plan, confirm, then remove
```

```bash
./uninstall.sh --dry-run
./uninstall.sh
```

| Flag | Effect |
| --- | --- |
| `-DryRun` / `--dry-run` | print the plan only |
| `-Yes` / `--yes` | skip the confirmation |
| `-KeepConfig` / `--keep-config` | keep `.env` (**your bot token stays on disk**) |
| `-KeepState` / `--keep-state` | keep `~/.discord-copilot-sdk` |
| `-Branches` / `--branches` | also delete `copilot/t-*` branches (**merged only**) |

### Removed

1. Residency settings (Scheduled Tasks / launchd / systemd for **all instances**) plus generated start wrappers
2. The running bot (all instances; stale locks are ignored)
3. Slash commands for that Discord server
4. Per-session git worktrees — **only when git can prove they are clean**
5. `~/.discord-copilot-sdk`: approval records ("always allow"), session records, logs, `.env` backups
6. The pre-rename `~/.discopilot`
7. `.env` — **including your bot token**

### Never touched

| Item | Reason |
| --- | --- |
| every repo under `REPOS_ROOT` | that is your code; this tool only ever added worktrees and branches there |
| `~/.copilot` | Copilot CLI login state belongs to the CLI, not this tool |
| node / git / Copilot CLI | they are shared machine prerequisites |
| Discord application itself | only you can delete it: <https://discord.com/developers/applications> |

### Deliberate trade-offs

- **`.env` goes by default**: the token is the most sensitive artifact here, and calling it "uninstalled" while the token sits on disk would be a half-truth. `-KeepConfig` is the escape hatch, and it says so at the end.
- Branches are kept by default because they can hold commits that exist nowhere else; `--branches` uses `git branch -d`, never `-D`, so git itself refuses the unmerged ones.
- Deregistering the slash commands is ordered before deleting `.env`, because it needs the token and `.env` is its only copy.
- The checkout is not deleted automatically — the script is running from inside it. The path is printed at the end.

> With no interactive terminal and no `--yes`, it changes nothing and says why.

### What "complete" does NOT mean

This is a **local** uninstall. These are the things it cannot do, and says so at the end:

- Deleting `.env` does not revoke the token; a leaked copy still works. Reset it or delete the application (the exact URL for your app is printed at the end).
- The bot remains a guild member, and its threads and messages remain.
- Copilot's own session data under `~/.copilot/session-state/` is not deleted — it belongs to the CLI.
- The checkout (with `node_modules` and `dist`, usually the largest residue) is not self-deleted.
- Nothing the unsandboxed agent did inside your repo is undone.

> ⚠️ **Two checkouts:** the state dir is shared, so running this in A removes state B also uses and stops B's bot — but **B's `.env`, and its token, is untouched**. The closing report says so.

> If any step fails — say the network drops while deregistering — it prints **`Uninstall INCOMPLETE`**, **keeps `.env`** (the only credential that could retry), and exits **1**. Re-run when fixed.

---

## 7. Safety

- Use a **private** Discord server, enable **2FA**.
- **Never** commit `.env` or your token (already in `.gitignore`; the installer refuses to write into a tracked `.env`).
- `.env` backups live under `~/.discord-copilot-sdk/env-backups/` (owner-only).

---

## 8. Troubleshooting

- **Node installed but shell can't find it** → close and reopen the terminal, then re-run.
- **Copilot not signed in** → run `copilot`, then `/login`.
- **PowerShell execution policy** → use `powershell -ExecutionPolicy Bypass -File ./install.ps1`.
- **Re-running** → safe and idempotent: uses your existing `.env` as defaults and backs it up before writing.

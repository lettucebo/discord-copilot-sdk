# One-line install + real 24/7 residency

Date: 2026-07-29 · Status: approved by autopilot (user unavailable; assumptions stated below)

## Problem

Two gaps against the sibling project `seam-acp`, which the user holds up as the
reference:

| | discord-copilot-sdk (before) | seam-acp |
|---|---|---|
| config wizard | `install.ps1` / `install.sh` (bilingual, installs Node/git/Copilot) | same |
| **remote one-liner** | **missing** — you must `git clone` first | `get.ps1` / `get.sh` |
| start/stop helpers | **missing** | `run-bot.*` / `stop-bot.*` |
| 24/7 | **login-keepalive only** | PM2 |

And one honesty bug: the installer prompt says
`是否設定 24/7 常駐（登入後自動啟動並保持存活）` / `Set up 24/7 residency`, but
`residency.mjs`'s own header admits the opposite:

    // Honest scope: this configures AUTO-START + KEEPALIVE WHILE THE USER IS
    // LOGGED IN ... True pre-login unattended startup needs extra steps

Log out and the bot stops. Calling that "24/7" is the same class of false message
the reviewers kept finding this session.

## The constraint that decides the design (verified, not assumed)

`node_modules/@github/copilot-sdk` contains **no token environment variable** —
no `GH_TOKEN`, `GITHUB_TOKEN`, or `COPILOT_TOKEN`. The runtime relies entirely on
the CLI's logged-in state under `%USERPROFILE%\.copilot` (which includes a
DPAPI-encrypted `m-encryption-key.enc`).

**Therefore 24/7 must run as the same OS user.** Running as SYSTEM, a service
account, or in Docker gives an unauthenticated Copilot. This eliminates the
obvious answers before they are proposed.

## Options considered for 24/7 (Windows)

| | A. Scheduled Task, "whether logged on or not" | B. auto-logon + existing at-logon task | C. PM2 / Docker |
|---|---|---|---|
| runs before login | yes | yes (after auto-logon) | no / auth broken |
| password stored | Windows Credential Manager, scoped to the task | LSA secret `DefaultPassword` | n/a |
| leaves a desktop unlocked | no (session 0) | **yes** | n/a |
| chosen | **yes** | no | no |

**A is chosen.** B leaves an unlocked desktop for anyone with physical access —
a strictly worse trade for the same benefit. C cannot work at all given the
constraint above: a container has no access to the host user's Copilot login.

## Design

### 1. `get.ps1` / `get.sh` — remote bootstrap

Ensure git → clone (or fast-forward an existing checkout) → hand off to the
repo's own installer **in a child process**.

Windows specifics, copied from `seam-acp`'s proven shape because the failure
modes are already known there:
- the whole body runs in an isolated child scope `& { ... }` so `irm | iex` does
  not leak variables into the caller's session
- it never calls `exit` — that would close the user's window; it throws/returns
- flags cannot be passed through a pipe, so the scriptblock form is documented

Env overrides: `DISCORD_COPILOT_SDK_DIR`, `DISCORD_COPILOT_SDK_REF`.

### 2. `run-bot.*` / `stop-bot.*`

Start the bot detached with the PATH/HOME fixes residency already needs, logging
to `~/.discord-copilot-sdk/logs/`. Stop reads the PID from the lock file the app
itself writes (`~/.discord-copilot-sdk/<instance>.lock`) — the helpers do not
maintain their own PID file, so they cannot disagree with the app's own
single-instance guard.

### 3. `--residency-24x7`

Windows: `Register-ScheduledTask` with an `-AtStartup` trigger plus `-User`, which
makes the task LogonType `Password` and clears `RunOnlyIfLoggedOn`.

**The password never touches a command line.** `schtasks /RP` and
`powershell -Command "...$pw..."` both put it in argv, which any process on the
machine can read via `Win32_Process.CommandLine`. Instead:
- prompted with the existing `askHidden` (real TTY required, never falls back)
- the registration script is written to PowerShell's **stdin**
- the password is passed in the **child process environment** only

Never written to a file, never echoed, never placed in `.env`.

**Non-interactive never escalates.** `--yes` selects login-keepalive; requesting
24/7 without a TTY is refused rather than silently downgraded or silently
prompted.

macOS: a LaunchAgent is login-bound and a LaunchDaemon runs as root, which breaks
Copilot auth — so macOS is documented as login-keepalive only, not quietly sold
as 24/7. Linux: `loginctl enable-linger` genuinely gives pre-login `systemd --user`,
so 24/7 is offered there.

### 4. Honesty fix

The existing option is relabelled "auto-start + keepalive **while logged in**";
only the new one is called 24/7.

### 5. Testability

`buildWindowsRegisterScript(opts)` becomes pure (options in, script text out) so
tests can assert what no integration test would catch cheaply:
- 24/7 mode contains `AtStartup` and `-User`, and reads the password from the
  environment
- the password literal never appears in the generated script
- login mode contains neither `-User` nor `-Password`
- the existing "refuse to replace a task that isn't ours" guard survives in both

## Out of scope

PM2 and Docker (ruled out by the auth constraint), and pre-login residency on
macOS (impossible without breaking auth).

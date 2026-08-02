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

## The constraint that decides the design

> **⚠️ CORRECTION (post-review).** The original text here claimed the SDK exposes
> no token and that Copilot auth therefore forces the resident process to run as
> the human user. **That is false.** It came from a bad search: I grepped
> `dist/*.js` for env-var *names* (`GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_TOKEN`) and
> treated the empty result as proof, never reading the *options* in
> `types.d.ts`.
>
> `@github/copilot-sdk` `CopilotClientOptions` does expose:
> - `gitHubToken` — "GitHub token to use for authentication. **This takes
>   priority over other authentication methods.**"
> - `useLoggedInUser` — "@default true (**but defaults to false when
>   `gitHubToken` is provided**)"
>
> `src/copilot/sdk.ts:99` hardcodes `useLoggedInUser: true`, so the restriction
> is **this app's choice**, not a Copilot limitation.

The design must therefore separate two requirements that the original wrongly
fused:

**1. Copilot authentication** — solvable with an explicit token. A headless
service identity is possible; nothing here needs a human login.

**2. OS execution identity** — the real constraint for *this* bot. The agent runs
shell commands, edits files in `CONTROLLED_REPO_PATH`, and creates git worktrees
under `${stateDir()}-worktrees` in the user's home. Another account breaks file
ownership across all of that, and SYSTEM would mean arbitrary commands execute as
SYSTEM — strictly worse for a tool whose entire security note is "the agent runs
shell commands as you".

So 24/7 still wants to run as the human user, but for **file ownership**, not
because Copilot could not authenticate otherwise. That is a product choice and
must be stated as one.

## Options considered for 24/7 (Windows)

| | A. Task, "whether logged on or not" | B. auto-logon + at-logon task | C. stay logged in, screen locked | D. service account + token |
|---|---|---|---|---|
| survives reboot | yes | yes | **no** | yes |
| survives logout | yes | yes | n/a | yes |
| password stored | task credential | LSA `DefaultPassword` | **none** | none (token instead) |
| unlocked desktop | no | **yes** | no | no |
| runs as you (file ownership) | yes | yes | yes | **no** |

**C is the honest default** for "keep running while I'm away" — no stored secret,
no unlocked desktop — and it was missing from the original comparison. **A** is
an advanced escape hatch for a disposable lab machine, and is the only option
that survives a reboot without a stored secret being someone else's problem. B
stays rejected: same benefit, unlocked desktop. D becomes viable once token auth
exists, but it changes file ownership, so it is separate work.

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

> **⚠️ CORRECTION (2026-08-01, post-shipping bug report).** The line above —
> "flags cannot be passed through a pipe, so the scriptblock form is
> documented" — implied the scriptblock form was otherwise fine. It was not:
> `get.ps1` ships with a UTF-8 BOM (required so PowerShell 5.1 parses the
> bilingual strings when run from disk; enforced by
> `test/shipped-scripts.test.ts`), and `Invoke-RestMethod` does **not** strip
> that BOM from the response body on **either** PowerShell 5.1 or 7 — this was
> verified empirically, not assumed. `iex` and `[scriptblock]::Create()` both
> parse a raw **string**, not a file, so the untrimmed BOM sat on the
> `#Requires` token and the whole script failed to parse (`#Requires`/`param`
> both reported as unrecognized commands) — a real user hit this running the
> exact command this doc recommended. The fix, documented in `README.md` /
> `INSTALL.md` and baked into `get.ps1`'s own header comment, is
> `.TrimStart([char]0xFEFF)` on the fetched string before
> `[scriptblock]::Create()`. The bare `irm ... | iex` form is no longer
> documented at all — even with the BOM fixed it still cannot take flags,
> and a documented command that sometimes works is worse than one that is
> simply not offered.
>
> **Why CI didn't catch it:** `lint-scripts` ran `bash -n install.sh` only —
> no `.ps1` was ever parsed by anything. Fixed by adding a `pwsh` step that
> decodes each shipped `.ps1` as `Invoke-RestMethod` actually would (BOM
> preserved as a leading `U+FEFF`), trims it, and feeds it to
> `[scriptblock]::Create()`; mirrored in `test/shipped-scripts.test.ts` (skips
> locally if `pwsh` is absent — the authoritative guard is CI, which runs on
> `ubuntu-latest` with `pwsh` preinstalled).

### 1a. Folder selection (2026-08-01 addition)

A second bug surfaced together with the BOM one: a user already standing
inside a clone of this repo still got a fresh, separate clone under
`~/discord-copilot-sdk`, because target resolution never looked at the
current directory — only `-Dir`/`DISCORD_COPILOT_SDK_DIR`/the hardcoded
default. That the BOM bug also silently swallowed `-Dir` (any flag, on any
documented form) is exactly why nobody could work around it by hand either.

**Resolution order** (`-Dir`/`--dir` and the env var keep top priority — no
behavior change for anyone already scripting this):
1. `-Dir` / `--dir` / `DISCORD_COPILOT_SDK_DIR`
2. Interactive (a real tty, and not `-Yes`/`--yes`/`-y`): detect whether the
   current directory or an ancestor is already a checkout of this repo (`git
   rev-parse --show-toplevel` + `git remote get-url origin`, normalized the
   same way the existing origin-mismatch guard already does) and offer a
   menu: reuse it as-is (default), install to the default path, or a custom
   path
3. Non-interactive (`-Yes`/no tty, e.g. CI): always the hardcoded default,
   no prompt — a scripted invocation must behave identically regardless of
   the caller's cwd, otherwise the same automation run in two different
   directories silently does two different things

**The one hard rule:** reusing a checkout detected this way **never** fetches
or checks out — it hands the directory to `install.ps1`/`install.sh` exactly
as it stands. The existing "already present → fetch + detach HEAD" update
path stays, but only for directories the bootstrapper itself manages (the
default path, the env var, `-Dir`, or a menu-typed custom path) — never for
the auto-detected "you're standing in it" choice. Detaching HEAD on a clone
someone is actively developing on (e.g. sitting on `main` with local commits)
would silence a correctness bug as a convenience feature. `get.sh`'s menu
reads from `/dev/tty` for the same reason the existing installer handoff
already does: its own stdin is the `curl` pipe.

> **⚠️ CORRECTION (2026-08-02, near-miss during real-world testing).** The
> paragraph above is wrong in one place: "never for the auto-detected
> 'you're standing in it' choice" implied every OTHER path (default,
> env var, `-Dir`, menu-typed custom path) was safe to fetch + detach. It is
> not. This got caught immediately because it happened to this very repo's
> own working checkout: running the fixed one-liner from `~` (not cd'd into
> the repo) and choosing menu option **[2] Custom path**, then typing this
> checkout's own path, hit the "bootstrap-managed directory" branch — which
> fetched and ran `checkout --detach FETCH_HEAD` on a real dev clone sitting
> on `main`, silently detaching it. `$reuseAsIs` only catches "you were cd'd
> into it when you ran the command"; it says nothing about a path you typed
> or passed with `-Dir` that happens to be some OTHER existing clone of this
> repo you weren't standing in.
>
> The real invariant was never "how did the user arrive at this path" — it
> is **whether the directory is currently sitting on a named branch**.
> `get.ps1`/`get.sh` now detach HEAD immediately after every clone they
> perform (`git checkout --detach HEAD` right after `git clone`), so every
> directory this script has ever fully managed is unambiguously in a
> detached state. The "already present" branch then checks
> `git symbolic-ref -q --short HEAD`: if it succeeds (attached to a branch),
> that is a human's own checkout and the script prints a message and does
> **nothing** to it (no fetch, no checkout) — regardless of whether the path
> came from the default, the env var, `-Dir`, or a menu-typed custom path.
> Only a directory already detached gets fetched and re-detached. This
> closes the gap for every entry point at once, rather than special-casing
> "custom path pointing at an existing clone" on top of `$reuseAsIs`.
>
> Recovery for this repo's own checkout (`main` was one commit ahead locally
> and untouched on the remote, so this was a pure fast-forward, not a rebase
> or history rewrite): `git merge-base --is-ancestor main HEAD` confirmed no
> divergence, then `git checkout main && git merge --ff-only <detached-sha>`
> reattached HEAD with zero data loss.

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

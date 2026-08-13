#Requires -Version 5.1
<#
  discord-copilot-sdk one-line network bootstrap (Windows).

  Run WITHOUT cloning first (note: NOT `| iex` — Invoke-Expression evaluates in
  the caller's scope, where this file's top-level param() degenerates into
  variable declarations, AND it cannot take flags at all). This file ships with
  a UTF-8 BOM (required so PowerShell 5.1 parses the bilingual strings when run
  from disk — see shipped-scripts.test.ts), but `Invoke-RestMethod` does NOT
  strip that BOM from the response body on EITHER PowerShell 5.1 or 7, and
  `[scriptblock]::Create()` parses a raw string (not a file), so an untrimmed
  BOM sits on the `#Requires` token and the script fails to parse. The
  TrimStart is therefore mandatory, not just a private-fork/pwsh nicety:
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF)))

  From a private fork, replace the `irm` with `gh api` (uses your existing
  GitHub login instead of the anonymous raw endpoint, which 404s on a private
  repo); the same TrimStart still applies:
    & ([scriptblock]::Create(((gh api repos/<owner>/discord-copilot-sdk/contents/get.ps1 -H "Accept: application/vnd.github.raw" | Out-String).TrimStart([char]0xFEFF))))

  Env overrides:
    DISCORD_COPILOT_SDK_DIR   target directory (default %USERPROFILE%\discord-copilot-sdk)
    DISCORD_COPILOT_SDK_REF   branch/tag to check out (default main)

  Ensures git, then either reuses an already-checked-out copy of this repo
  as-is (no fetch, no checkout — never touches YOUR working tree's HEAD) or
  clones/fast-forwards into the resolved target directory, then hands off to
  the repo's install.ps1 in a CHILD process (isolated session + ExecutionPolicy
  Bypass). See "folder resolution" below for how the target is chosen.

  NOTE: this runs inside YOUR PowerShell session. The whole body runs in an
  isolated child scope (& { ... }) so it does NOT leak variables/functions into
  your session, and it NEVER calls `exit` — that would close your window. Errors
  propagate as terminating errors instead.

  Folder resolution (highest priority first):
    1. -Dir <path> / DISCORD_COPILOT_SDK_DIR env var
    2. Interactive: if the current directory (or an ancestor) is already a
       discord-copilot-sdk checkout, offer to reuse it, install to the default,
       or a custom path
    3. Non-interactive (-Yes, or no TTY): default %USERPROFILE%\discord-copilot-sdk,
       no prompt — so scripted/CI invocations never depend on the caller's cwd
  Reusing an existing checkout NEVER fetches or checks out — it hands off to
  that directory's install.ps1 exactly as it stands, because detaching HEAD on
  a clone you are actively developing in would be a correctness bug, not a
  convenience.
#>
param(
  # NOTE: no [ValidateSet] here. When this file is run as `irm ... | iex`,
  # Invoke-Expression evaluates it in the CALLER'S scope, where a top-level
  # param() degenerates into variable declarations — and applying a ValidateSet
  # attribute to $Lang (default '') throws before a single line of the body runs.
  # Validation happens in the inner scope instead.
  [string]$Lang,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Residency,
  [switch]$Residency24x7,
  [switch]$NoResidency,
  [switch]$SkipAuth,
  [string]$Dir,
  [string]$Ref
)

& {
  param(
    [string]$Lang, [switch]$Yes, [switch]$DryRun, [switch]$Residency,
    [switch]$Residency24x7, [switch]$NoResidency, [switch]$SkipAuth,
    [string]$Dir, [string]$Ref
  )
  # Set in this child scope only — does not leak into the caller's session.
  $ErrorActionPreference = 'Stop'
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

  if ($Lang -and $Lang -notin @('zh', 'en')) { throw "-Lang must be 'zh' or 'en'" }
  $zh = if ($Lang) { $Lang -eq 'zh' } else { (Get-UICulture).Name -like 'zh*' }
  function Say($z, $e) { Write-Host $(if ($zh) { $z } else { $e }) }

  # PowerShell does not throw on a native command's non-zero exit, so every git
  # call is checked. Without this an failed fetch/checkout would fall through and
  # silently hand off to the OLD installer.
  function Invoke-Git {
    param([string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" }
  }

  # Forward only the switches the caller actually set.
  $forward = @()
  foreach ($n in 'Yes', 'DryRun', 'Residency', 'Residency24x7', 'NoResidency', 'SkipAuth') {
    if ($PSBoundParameters.ContainsKey($n) -and $PSBoundParameters[$n]) { $forward += "-$n" }
  }
  if ($Lang) { $forward += @('-Lang', $Lang) }

  $repoUrl = 'https://github.com/lettucebo/discord-copilot-sdk.git'
  $ref = if ($Ref) { $Ref } elseif ($env:DISCORD_COPILOT_SDK_REF) { $env:DISCORD_COPILOT_SDK_REF } else { 'main' }
  $norm = { param($u) ($u -replace '\.git$', '' -replace '/$', '').ToLowerInvariant() }

  Say '== discord-copilot-sdk ==' '== discord-copilot-sdk =='

  Say '[1/2] 網路啟動器（Windows）' '[1/2] Network bootstrap (Windows)'

  # --- git --- (must run before folder detection below, which shells out to git)
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Say '找不到 git，嘗試用 winget 安裝…' 'git not found; installing with winget…'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget not found. Install Git manually from https://git-scm.com/download/win then re-run.'
    }
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    # winget updates the machine PATH, not this already-running shell.
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      throw 'Git installed but not visible in this shell. Close and reopen the terminal, then re-run.'
    }
  }

  # Is the CURRENT directory (or an ancestor) already a checkout of THIS repo?
  # Returns $null rather than throwing for "not a repo at all" / "no origin" /
  # "origin is something else" — those are all just "no, nothing to detect".
  function Find-ExistingCheckout {
    $top = $null
    try { $top = (& git rev-parse --show-toplevel 2>$null) } catch { return $null }
    if ($LASTEXITCODE -ne 0 -or -not $top) { return $null }
    $origin = (& git -C $top remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $origin) { return $null }
    if ((& $norm $origin) -ne (& $norm $repoUrl)) { return $null }
    # git prints forward slashes even on Windows; normalize for display/Test-Path.
    return ($top -replace '/', '\')
  }

  # A non-interactive run (scripted, CI, -Yes, no console) must behave the same
  # regardless of the caller's cwd — so it never prompts and never auto-reuses
  # a directory it merely happens to be standing in.
  function Test-Interactive {
    if ($Yes) { return $false }
    try { return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) }
    catch { return $false }
  }

  # --- resolve target directory ---
  # Priority: -Dir / env var > interactive chooser > non-interactive default.
  # Only the interactive "reuse the checkout I'm standing in" choice sets
  # $reuseAsIs — that is the ONE path that must never fetch/checkout (see below).
  $reuseAsIs = $false
  if ($Dir) {
    $target = $Dir
  }
  elseif ($env:DISCORD_COPILOT_SDK_DIR) {
    $target = $env:DISCORD_COPILOT_SDK_DIR
  }
  else {
    $defaultTarget = Join-Path $env:USERPROFILE 'discord-copilot-sdk'
    if (Test-Interactive) {
      $existing = Find-ExistingCheckout
      if ($existing) {
        Say "找到現有的 checkout：$existing" "Found an existing checkout: $existing"
        Say '  [1] 使用現有的（預設，不會更新）' '  [1] Use it as-is (default, not updated)'
        Say "  [2] 安裝到 $defaultTarget" "  [2] Install to $defaultTarget"
        Say '  [3] 自訂路徑' '  [3] Custom path'
        $choice = Read-Host $(if ($zh) { '請選擇' } else { 'Choose' })
        switch ($choice) {
          '2' { $target = $defaultTarget }
          '3' { $target = Read-Host $(if ($zh) { '請輸入路徑' } else { 'Enter path' }) }
          default { $target = $existing; $reuseAsIs = $true }
        }
      }
      else {
        Say "  [1] 安裝到 $defaultTarget（預設）" "  [1] Install to $defaultTarget (default)"
        Say '  [2] 自訂路徑' '  [2] Custom path'
        $choice = Read-Host $(if ($zh) { '請選擇' } else { 'Choose' })
        switch ($choice) {
          '2' { $target = Read-Host $(if ($zh) { '請輸入路徑' } else { 'Enter path' }) }
          default { $target = $defaultTarget }
        }
      }
      if (-not $target) { throw 'A target directory is required.' }
    }
    else {
      $target = $defaultTarget
    }
  }

  Say "  目標目錄：$target" "  Target: $target"
  Say "  分支/標籤：$ref" "  Ref: $ref"

  # --- clone or update ---
  if ($reuseAsIs) {
    # Chosen from the menu above: the user was already standing inside this
    # checkout. Never fetch/checkout here — that would detach HEAD out from
    # under a clone someone might be actively developing in (e.g. on `main`).
    Say '使用你現有的 checkout（未更新）…' 'Using your existing checkout (not updated)…'
  }
  elseif (Test-Path (Join-Path $target '.git')) {
    # A directory being A git repo does not make it OUR git repo. Without this
    # check the update path would fetch from a STRANGER'S origin, detach their
    # HEAD onto it, and then hand off to whatever install.ps1 it found there.
    $origin = (& git -C $target remote get-url origin 2>$null)
    if (-not $origin -or (& $norm $origin) -ne (& $norm $repoUrl)) {
      throw "$target is a git repo whose origin is '$origin', not $repoUrl. Set DISCORD_COPILOT_SDK_DIR to somewhere else."
    }
    # A target reached via -Dir/DISCORD_COPILOT_SDK_DIR/a menu-typed custom
    # path can ALSO be an existing dev clone the user pointed us at without
    # standing inside it — $reuseAsIs only catches the case where they were
    # cd'd into it. So the real signal for "is this ours to rewrite" is
    # whether it's SITTING ON A NAMED BRANCH: every clone/update this script
    # performs immediately detaches HEAD (see below), so an attached branch
    # here means a human is developing on it, and fetch + detach would
    # silently rip their HEAD off that branch — exactly the bug this whole
    # detection feature exists to prevent, just reached through a path we
    # hadn't covered (a REAL detach-out-from-under-a-dev-clone incident is
    # what motivated this check).
    $onBranch = (& git -C $target symbolic-ref -q --short HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $onBranch) {
      Say "已存在且在分支 $onBranch 上；為避免打斷你的工作，不會更新（不會 fetch/checkout）…" "Already present and on branch $onBranch; not updating so as not to disturb your work (no fetch/checkout)…"
    }
    else {
      Say '已存在，改為更新…' 'Already present; updating…'
      Invoke-Git @('-C', $target, 'fetch', '--depth', '1', 'origin', $ref)
      Invoke-Git @('-C', $target, 'checkout', '-q', '--detach', 'FETCH_HEAD')
    }
  }
  elseif (Test-Path $target) {
    # Refuse to clone into a non-empty directory that is not our repo — that is
    # someone else's data.
    if ((Get-ChildItem -LiteralPath $target -Force | Measure-Object).Count -gt 0) {
      throw "$target exists and is not a discord-copilot-sdk checkout. Set DISCORD_COPILOT_SDK_DIR to somewhere else."
    }
    Invoke-Git @('clone', '--depth', '1', '--branch', $ref, $repoUrl, $target)
    # Detach immediately so this managed clone is indistinguishable-by-git-state
    # from one just fetched+detached above — that is what lets the NEXT run
    # recognize it as bootstrap-managed (detached) rather than a dev clone
    # (on a branch) and safely update it again.
    Invoke-Git @('-C', $target, 'checkout', '-q', '--detach', 'HEAD')
  }
  else {
    Invoke-Git @('clone', '--depth', '1', '--branch', $ref, $repoUrl, $target)
    Invoke-Git @('-C', $target, 'checkout', '-q', '--detach', 'HEAD')
  }

  # --- hand off to the repo's installer, in a CHILD process ---
  $installer = Join-Path $target 'install.ps1'
  if (-not (Test-Path $installer)) { throw "install.ps1 not found at $installer" }
  Say '[2/2] 交給本機安裝器…' '[2/2] Handing off to the local installer…'
  $psExe = (Get-Process -Id $PID).Path
  if (-not $psExe) { $psExe = 'powershell.exe' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $installer @forward
  if ($LASTEXITCODE -ne 0) { throw "installer exited with code $LASTEXITCODE" }

  Say "完成。原始碼在：$target" "Done. Source is at: $target"
} @PSBoundParameters

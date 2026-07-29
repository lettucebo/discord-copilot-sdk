#Requires -Version 5.1
<#
  discord-copilot-sdk one-line network bootstrap (Windows).

  Run WITHOUT cloning first (note: NOT `| iex` — Invoke-Expression evaluates in
  the caller's scope, where this file's top-level param() degenerates into
  variable declarations):
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1)))

  From a PRIVATE repo (this one), and from PowerShell 7, the BOM must be trimmed
  because pwsh does not strip it from native-command output:
    & ([scriptblock]::Create(((gh api repos/lettucebo/discord-copilot-sdk/contents/get.ps1 -H "Accept: application/vnd.github.raw" | Out-String).TrimStart([char]0xFEFF))))

  Env overrides:
    DISCORD_COPILOT_SDK_DIR   target directory (default %USERPROFILE%\discord-copilot-sdk)
    DISCORD_COPILOT_SDK_REF   branch/tag to check out (default main)

  Ensures git, clones (or fast-forwards) the repo, then hands off to the repo's
  install.ps1 in a CHILD process (isolated session + ExecutionPolicy Bypass).

  NOTE: this runs inside YOUR PowerShell session (iex). The whole body runs in an
  isolated child scope (& { ... }) so it does NOT leak variables/functions into
  your session, and it NEVER calls `exit` — that would close your window. Errors
  propagate as terminating errors instead.
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
  $target = if ($Dir) { $Dir }
  elseif ($env:DISCORD_COPILOT_SDK_DIR) { $env:DISCORD_COPILOT_SDK_DIR }
  else { Join-Path $env:USERPROFILE 'discord-copilot-sdk' }

  Say 'discord-copilot-sdk 一鍵安裝（網路啟動器）' 'discord-copilot-sdk one-line bootstrap'
  Say "  目標目錄：$target" "  Target: $target"
  Say "  分支/標籤：$ref" "  Ref: $ref"

  # --- git ---
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

  # --- clone or update ---
  if (Test-Path (Join-Path $target '.git')) {
    # A directory being A git repo does not make it OUR git repo. Without this
    # check the update path would fetch from a STRANGER'S origin, detach their
    # HEAD onto it, and then hand off to whatever install.ps1 it found there.
    $origin = (& git -C $target remote get-url origin 2>$null)
    $norm = { param($u) ($u -replace '\.git$', '' -replace '/$', '').ToLowerInvariant() }
    if (-not $origin -or (& $norm $origin) -ne (& $norm $repoUrl)) {
      throw "$target is a git repo whose origin is '$origin', not $repoUrl. Set DISCORD_COPILOT_SDK_DIR to somewhere else."
    }
    Say '已存在，改為更新…' 'Already present; updating…'
    Invoke-Git @('-C', $target, 'fetch', '--depth', '1', 'origin', $ref)
    Invoke-Git @('-C', $target, 'checkout', '-q', '--detach', 'FETCH_HEAD')
  }
  elseif (Test-Path $target) {
    # Refuse to clone into a non-empty directory that is not our repo — that is
    # someone else's data.
    if ((Get-ChildItem -LiteralPath $target -Force | Measure-Object).Count -gt 0) {
      throw "$target exists and is not a discord-copilot-sdk checkout. Set DISCORD_COPILOT_SDK_DIR to somewhere else."
    }
    Invoke-Git @('clone', '--depth', '1', '--branch', $ref, $repoUrl, $target)
  }
  else {
    Invoke-Git @('clone', '--depth', '1', '--branch', $ref, $repoUrl, $target)
  }

  # --- hand off to the repo's installer, in a CHILD process ---
  $installer = Join-Path $target 'install.ps1'
  if (-not (Test-Path $installer)) { throw "install.ps1 not found at $installer" }
  Say '交給安裝器…' 'Handing off to the installer…'
  $psExe = (Get-Process -Id $PID).Path
  if (-not $psExe) { $psExe = 'powershell.exe' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $installer @forward
  if ($LASTEXITCODE -ne 0) { throw "installer exited with code $LASTEXITCODE" }

  Say "完成。原始碼在：$target" "Done. Source is at: $target"
} @PSBoundParameters

#Requires -Version 5.1
<#
  discord-copilot-sdk uninstaller (Windows).

    ./uninstall.ps1                # show the plan, ask, then remove everything
    ./uninstall.ps1 -DryRun        # show the plan only, change nothing
    ./uninstall.ps1 -Yes           # no confirmation prompt
    ./uninstall.ps1 -KeepConfig    # keep .env — NOTE: your bot token stays on disk
    ./uninstall.ps1 -KeepState     # keep ~/.discord-copilot-sdk
    ./uninstall.ps1 -Branches      # also delete copilot/t-* branches (merged only)
    ./uninstall.ps1 -Lang zh|en

  A thin bootstrap, exactly like install.ps1: it finds node and hands off to
  scripts/uninstall.mjs, so there is ONE implementation to get right and to test.

  This never deletes your controlled repo, never touches ~/.copilot (your Copilot
  CLI login), and never removes a worktree that git cannot prove is clean.
#>
[CmdletBinding()]
param(
  [ValidateSet('zh', 'en')] [string]$Lang,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$KeepConfig,
  [switch]$KeepState,
  [switch]$Branches
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if (-not $Lang) { $Lang = if ((Get-UICulture).Name -like 'zh*') { 'zh' } else { 'en' } }
$env:DISCORD_COPILOT_SDK_LOCALE = if ($Lang -eq 'zh') { 'zh-TW' } else { 'en-US' }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  if ($Lang -eq 'zh') {
    Write-Host '找不到 node。解除安裝需要 Node.js；若已移除，可手動刪除下列項目：'
  }
  else {
    Write-Host 'node not found. The uninstaller needs Node.js. If you removed it, delete these by hand:'
  }
  Write-Host "  $env:USERPROFILE\.discord-copilot-sdk"
  Write-Host "  $env:USERPROFILE\.discord-copilot-sdk-worktrees"
  Write-Host "  $PSScriptRoot\.env"
  Write-Host '  schtasks /Delete /TN discord-copilot-sdk-default /F'
  throw 'node is required'
}

$fwd = @()
if ($Yes) { $fwd += '--yes' }
if ($DryRun) { $fwd += '--dry-run' }
if ($KeepConfig) { $fwd += '--keep-config' }
if ($KeepState) { $fwd += '--keep-state' }
if ($Branches) { $fwd += '--branches' }
$fwd += @('--lang', $Lang)

& $node (Join-Path $PSScriptRoot 'scripts\uninstall.mjs') @fwd
exit $LASTEXITCODE

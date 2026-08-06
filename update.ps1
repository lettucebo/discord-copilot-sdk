#Requires -Version 5.1
<#
  discord-copilot-sdk update entrypoint (Windows).

    ./update.ps1 [-Check] [-DryRun] [-Ref v0.1.0] [-AllInstances] [-Restore]

  Network form (do NOT evaluate a download pipeline):

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.ps1).TrimStart([char]0xFEFF)))

  Network execution downloads a current updater engine to a private temporary
  directory. That engine then stops the bot BEFORE it moves the target checkout,
  preventing npm from replacing files held by a live process.
#>
[CmdletBinding()]
param(
  [ValidateSet('zh', 'en')] [string]$Lang,
  [switch]$Check,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$NoRestart,
  [switch]$AllInstances,
  [switch]$Restore,
  [string]$Ref,
  [string]$Dir
)

& {
  param(
    [string]$Lang, [switch]$Check, [switch]$DryRun, [switch]$Yes,
    [switch]$NoRestart, [switch]$AllInstances, [switch]$Restore,
    [string]$Ref, [string]$Dir
  )
  $ErrorActionPreference = 'Stop'
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

  $forward = @()
  if ($Lang) { $forward += @('--lang', $Lang) }
  if ($Check) { $forward += '--check' }
  if ($DryRun) { $forward += '--dry-run' }
  if ($Yes) { $forward += '--yes' }
  if ($NoRestart) { $forward += '--no-restart' }
  if ($AllInstances) { $forward += '--all-instances' }
  if ($Restore) { $forward += '--restore' }
  if ($Ref) { $forward += @('--ref', $Ref) }

  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'scripts\update.mjs'))) {
    & node (Join-Path $PSScriptRoot 'scripts\update.mjs') @forward
    return
  }

  $git = (Get-Command git -ErrorAction SilentlyContinue).Source
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $git -or -not $node) { throw 'git and Node.js are required; run get.ps1 first.' }

  $repoUrl = 'https://github.com/lettucebo/discord-copilot-sdk.git'
  $rawUrl = 'https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk'
  $refName = if ($Ref) { $Ref } elseif ($env:DISCORD_COPILOT_SDK_REF) { $env:DISCORD_COPILOT_SDK_REF } else { 'main' }
  $norm = { param($u) ($u -replace '\.git$', '' -replace '/$', '').ToLowerInvariant() }
  $target = if ($Dir) { $Dir } elseif ($env:DISCORD_COPILOT_SDK_DIR) { $env:DISCORD_COPILOT_SDK_DIR } else { $null }
  if (-not $target) {
    $top = (& git rev-parse --show-toplevel 2>$null)
    $origin = if ($LASTEXITCODE -eq 0 -and $top) { (& git -C $top remote get-url origin 2>$null) } else { '' }
    if ($origin -and (& $norm $origin) -eq (& $norm $repoUrl)) { $target = $top } else { $target = Join-Path $env:USERPROFILE 'discord-copilot-sdk' }
  }

  $temp = Join-Path ([IO.Path]::GetTempPath()) ("dcs-update-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  try {
    foreach ($relative in 'scripts/update.mjs', 'scripts/lib/update-core.mjs', 'scripts/lib/setup-core.mjs', 'scripts/lib/i18n.mjs') {
      $destination = Join-Path $temp ($relative -replace '/', '\')
      New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
      $uri = "$rawUrl/$([Uri]::EscapeDataString($refName))/$relative"
      $body = Invoke-RestMethod -Uri $uri -ErrorAction Stop
      [IO.File]::WriteAllText($destination, [string]$body, (New-Object Text.UTF8Encoding($false)))
    }
    $env:DISCORD_COPILOT_SDK_UPDATE_ROOT = [IO.Path]::GetFullPath($target)
    & $node (Join-Path $temp 'scripts\update.mjs') @forward
    return
  }
  finally {
    Remove-Item Env:\DISCORD_COPILOT_SDK_UPDATE_ROOT -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
} @PSBoundParameters

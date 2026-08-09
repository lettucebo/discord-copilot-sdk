#Requires -Version 5.1
<#
  Start the bot detached, waiting until Discord is fully ready.

    ./run-bot.ps1              # start (refuses if already running)
    ./run-bot.ps1 -Foreground  # run in this window instead

  Detached startup is delegated to scripts/run.mjs. It waits for the app's
  owner lock plus a one-time ready proof, so a process that merely survives a
  short sleep is never reported as started.
#>
[CmdletBinding()]
param([switch]$Foreground)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = $PSScriptRoot

if (-not (Test-Path (Join-Path $root 'dist/index.js'))) {
  Write-Host '尚未建置，正在執行 npm run build… / Not built yet, running npm run build…'
  Push-Location $root
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  finally { Pop-Location }
}

# The Scheduled Task environment has almost no PATH; keep this script and the
# residency wrapper behaving identically so "works here, fails there" cannot happen.
$copilotDir = (Get-Command copilot -ErrorAction SilentlyContinue).Source
if ($copilotDir) { $env:PATH = (Split-Path $copilotDir) + ';' + $env:PATH }
$env:HOME = $env:USERPROFILE

Push-Location $root
try {
  if ($Foreground) {
    node dist/index.js
  }
  else {
    node scripts/run.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
finally { Pop-Location }

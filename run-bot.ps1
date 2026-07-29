#Requires -Version 5.1
<#
  Start the bot detached, with the same PATH/HOME fixes residency needs.

    ./run-bot.ps1              # start (refuses if already running)
    ./run-bot.ps1 -Foreground  # run in this window instead

  The PID is NOT tracked here: the app writes its own lock at
  ~/.discord-copilot-sdk/<instance>.lock, and a second source of truth could
  disagree with it. stop-bot.ps1 reads that same lock.
#>
[CmdletBinding()]
param([switch]$Foreground)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = $PSScriptRoot
# Same rule as the app (src/core/paths.ts): an id the app rejects would make this
# script read a different lock than the app writes, so it would start a second
# process that then dies on the app's own lock.
$rawId = if ($env:DISCORD_COPILOT_SDK_INSTANCE_ID) { $env:DISCORD_COPILOT_SDK_INSTANCE_ID.Trim() } else { '' }
$instance = if ($rawId -match '^[A-Za-z0-9._-]{1,64}$') { $rawId } else { 'default' }
$stateDir = Join-Path $env:USERPROFILE '.discord-copilot-sdk'
$lock = Join-Path $stateDir "$instance.lock"

# Already running? The app would refuse anyway; say so clearly instead.
if (Test-Path $lock) {
  $existing = (Get-Content $lock -Raw).Trim()
  if ($existing -match '^\d+$' -and (Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue)) {
    Write-Host "已在執行中 (PID $existing)。先執行 ./stop-bot.ps1 再啟動。"
    Write-Host "Already running (PID $existing). Run ./stop-bot.ps1 first."
    return
  }
}

if (-not (Test-Path (Join-Path $root 'dist/index.js'))) {
  Write-Host '尚未建置，正在執行 npm run build… / Not built yet, running npm run build…'
  Push-Location $root
  try { npm run build } finally { Pop-Location }
}

# The Scheduled Task environment has almost no PATH; keep this script and the
# residency wrapper behaving identically so "works here, fails there" cannot happen.
$copilotDir = (Get-Command copilot -ErrorAction SilentlyContinue).Source
if ($copilotDir) { $env:PATH = (Split-Path $copilotDir) + ';' + $env:PATH }
$env:HOME = $env:USERPROFILE

New-Item -ItemType Directory -Force -Path (Join-Path $stateDir 'logs') | Out-Null
$log = Join-Path $stateDir "logs\run-bot.$instance.log"

Push-Location $root
try {
  if ($Foreground) {
    node dist/index.js
  }
  else {
    $p = Start-Process node -ArgumentList 'dist/index.js' -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    Start-Sleep -Seconds 2
    if ($p.HasExited) {
      Write-Host "啟動失敗，請看記錄 / Failed to start, see: $log"
      Get-Content "$log.err" -Tail 20 -ErrorAction SilentlyContinue
      throw 'bot exited immediately'
    }
    Write-Host "已啟動 (PID $($p.Id))。記錄 / Log: $log"
    Write-Host '停止 / Stop: ./stop-bot.ps1'
  }
}
finally { Pop-Location }

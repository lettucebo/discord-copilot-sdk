#Requires -Version 5.1
<#
  Stop the bot started by run-bot.ps1 (or by the residency task).

  Reads the PID from the lock the APP itself writes
  (~/.discord-copilot-sdk/<instance>.lock) rather than keeping a second,
  disagreeable copy.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$instance = if ($env:DISCORD_COPILOT_SDK_INSTANCE_ID) { $env:DISCORD_COPILOT_SDK_INSTANCE_ID } else { 'default' }
$lock = Join-Path $env:USERPROFILE ".discord-copilot-sdk\$instance.lock"

if (-not (Test-Path $lock)) {
  Write-Host '沒有在執行（找不到 lock）。/ Not running (no lock file).'
  return
}

$raw = (Get-Content $lock -Raw).Trim()
if ($raw -notmatch '^\d+$') {
  Write-Host "lock 內容無法解析 / unreadable lock contents: $lock"
  return
}

$procId = [int]$raw
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Host "PID $procId 已經不在了（lock 是舊的）。/ PID $procId is already gone (stale lock)."
  return
}

# Only stop something that is actually our bot — a recycled PID could be anything.
if ($proc.ProcessName -ne 'node') {
  Write-Host "PID $procId 是 '$($proc.ProcessName)'，不是 node — 不動它。"
  Write-Host "PID $procId is '$($proc.ProcessName)', not node — refusing to stop it."
  return
}

Stop-Process -Id $procId -Force
Write-Host "已停止 (PID $procId)。/ Stopped (PID $procId)."

# If residency is installed the task would restart it; say so rather than
# leaving the operator wondering why it came back.
$task = Get-ScheduledTask -TaskName "discord-copilot-sdk-$instance" -ErrorAction SilentlyContinue
if ($task) {
  Write-Host "注意：常駐工作 'discord-copilot-sdk-$instance' 仍啟用，可能會自動重啟。"
  Write-Host "Note: residency task 'discord-copilot-sdk-$instance' is still enabled and may restart it."
  Write-Host "  schtasks /End /TN discord-copilot-sdk-$instance"
}

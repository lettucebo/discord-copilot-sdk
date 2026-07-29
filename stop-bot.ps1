#Requires -Version 5.1
<#
  Stop the bot started by run-bot.ps1 (or by the residency task).

  Reads the PID from the lock the APP itself writes
  (~/.discord-copilot-sdk/<instance>.lock) rather than keeping a second,
  disagreeable copy.

  If residency is installed the SCHEDULER is the lifecycle authority — it is
  registered with RestartCount 999 / RestartInterval 1 minute, so killing only
  the process just makes it come back. The task is ended first.

    ./stop-bot.ps1            # stop now (task stays registered for next boot)
    ./stop-bot.ps1 -Disable   # also disable the task, so it stays down
#>
[CmdletBinding()]
param([switch]$Disable)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Same rule as the app (src/core/paths.ts) and residency.mjs. Without it an id
# the app rejects makes the helpers read a different lock than the app writes, so
# stop-bot would report "not running" and could never stop anything.
$rawId = if ($env:DISCORD_COPILOT_SDK_INSTANCE_ID) { $env:DISCORD_COPILOT_SDK_INSTANCE_ID.Trim() } else { '' }
$instance = if ($rawId -match '^[A-Za-z0-9._-]{1,64}$') { $rawId } else { 'default' }
$lock = Join-Path $env:USERPROFILE ".discord-copilot-sdk\$instance.lock"
$taskName = "discord-copilot-sdk-$instance"

# 1) Take the scheduler out of the loop FIRST, or it restarts what we kill.
if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Host "已停止常駐工作 / Stopped residency task: $taskName"
    if ($Disable) {
      Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
      Write-Host '已停用，開機不會再啟動。/ Disabled; it will not start at boot.'
      Write-Host "  重新啟用 / Re-enable: Enable-ScheduledTask -TaskName $taskName"
    }
    else {
      Write-Host '工作仍註冊著，下次開機／登入會再啟動；要保持關閉請加 -Disable。'
      Write-Host 'Task stays registered and starts again at boot/logon; use -Disable to keep it down.'
    }
  }
}

if (-not (Test-Path $lock)) {
  Write-Host '沒有在執行（找不到 lock）。/ Not running (no lock file).'
  return
}

$lockText = (Get-Content $lock -Raw).Trim()
if ($lockText -notmatch '^\d+$') {
  Write-Host "lock 內容無法解析 / unreadable lock contents: $lock"
  return
}

$procId = [int]$lockText
if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
  Write-Host "PID $procId 已經不在了（lock 是舊的）。/ PID $procId is already gone (stale lock)."
  return
}

# 2) Prove it is OUR bot before killing it. The lock survives a crash, PIDs are
#    reused, and "it is called node" is not identity — this machine can easily
#    have a dozen unrelated node processes. Match the command line.
$cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).CommandLine
if (-not $cmdLine -or $cmdLine -notmatch 'dist[\\/]index\.js') {
  Write-Host "PID $procId 的指令列不像這個 bot — 不動它。/ PID $procId does not look like this bot — refusing."
  Write-Host "  $cmdLine"
  return
}

Stop-Process -Id $procId -Force
Write-Host "已停止 (PID $procId)。/ Stopped (PID $procId)."

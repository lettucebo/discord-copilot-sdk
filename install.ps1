#Requires -Version 5.1
<#
  discord-copilot-sdk Windows installer (bootstrap). Ensures prerequisites (Node, git,
  GitHub Copilot CLI) then hands off to the shared bilingual config engine
  scripts/setup.mjs. Language: detected from the Windows UI culture, overridable
  with -Lang; setup.mjs shows the interactive chooser.

  Usage:
    ./install.ps1 [-Lang zh|en] [-Yes] [-DryRun] [-Residency] [-Residency24x7] [-NoResidency] [-SkipAuth] [-Verbose]
#>
[CmdletBinding()]
param(
  [ValidateSet('zh', 'en')] [string]$Lang,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Residency,
  [switch]$Residency24x7,
  [switch]$NoResidency,
  [switch]$SkipAuth
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# --- language (UI culture, not formatting culture) ---
function Resolve-Lang {
  if ($Lang) { return $Lang }
  $ui = ''
  try { $ui = (Get-UICulture).Name } catch {}
  if (-not $ui) { $ui = $PSUICulture }
  if ($ui -like 'zh*') { return 'zh' } else { return 'en' }
}
$L = Resolve-Lang
$env:DISCORD_COPILOT_SDK_LOCALE = if ($L -eq 'zh') { 'zh-TW' } else { 'en-US' }

# --- tiny bilingual bootstrap strings (Node not guaranteed yet) ---
$T = @{
  zh = @{
    banner   = 'discord-copilot-sdk'
    stage1 = '[1/2] Windows 安裝器'
    checking = '檢查前置需求（Node / git / Copilot CLI）…'
    haveNode = 'Node 版本'
    installing = '正在安裝'
    installedManual = '無法自動安裝，請手動安裝後重新執行：'
    reopen   = '已安裝相依套件，但目前的終端機可能還找不到它。請「關閉並重新開啟」終端機後再次執行本腳本。'
    nowNode  = '[2/2] 交給本機設定…'
    needWinget = '找不到 winget。請先安裝「應用程式安裝程式」(App Installer) 或手動安裝 Node/git/Copilot。'
    dry = '（-DryRun：不會安裝或變更任何東西。）'
  }
  en = @{
    banner   = 'discord-copilot-sdk'
    stage1 = '[1/2] Windows installer'
    checking = 'Checking prerequisites (Node / git / Copilot CLI)…'
    haveNode = 'Node version'
    installing = 'Installing'
    installedManual = 'Could not auto-install; please install manually and re-run: '
    reopen   = 'Installed dependencies, but this terminal may not see them yet. CLOSE and REOPEN the terminal, then run this script again.'
    nowNode  = '[2/2] Handing off to local setup…'
    needWinget = 'winget not found. Install "App Installer" first, or install Node/git/Copilot manually.'
    dry = '(-DryRun: nothing will be installed or changed.)'
  }
}
function Msg([string]$k) { return $T[$L][$k] }

Write-Host ("== " + (Msg 'banner') + " ==") -ForegroundColor Cyan
Write-Host (Msg 'stage1') -ForegroundColor Cyan
if ($DryRun) { Write-Host (Msg 'dry') -ForegroundColor DarkGray }

function Test-Cmd([string]$name) {
  $null = Get-Command $name -ErrorAction SilentlyContinue
  return $?
}
function Test-NodeOk {
  if (-not (Test-Cmd 'node')) { return $false }
  try {
    $v = (& node -e "const [a,b]=process.versions.node.split('.').map(Number); process.stdout.write((a===20?b>=19:(a>=22&&(a>22||b>=12)))?'ok':'old')")
    return ($v -eq 'ok')
  } catch { return $false }
}

Write-Host (Msg 'checking')

# winget package ids
$pkgs = @(
  @{ cmd = 'node'; id = 'OpenJS.NodeJS.LTS'; ok = { Test-NodeOk } },
  @{ cmd = 'git';  id = 'Git.Git';           ok = { Test-Cmd 'git' } },
  @{ cmd = 'copilot'; id = 'GitHub.Copilot';  ok = { Test-Cmd 'copilot' } }
)

$needInstall = @()
foreach ($p in $pkgs) { if (-not (& $p.ok)) { $needInstall += $p } }

if ($needInstall.Count -gt 0 -and -not $DryRun) {
  if (-not (Test-Cmd 'winget')) { throw (Msg 'needWinget') }
  foreach ($p in $needInstall) {
    Write-Host ((Msg 'installing') + " " + $p.id + " …")
    winget install --id $p.id -e --source winget --accept-package-agreements --accept-source-agreements --silent
    # Native commands don't throw on non-zero under PS 5.1 even with -Stop, so
    # check the exit code explicitly.
    if ($LASTEXITCODE -ne 0) { throw ((Msg 'installedManual') + $p.id) }
  }
  # Refresh PATH for THIS process (PREPEND the machine+user PATH so any
  # process-only entries are kept) so we can re-verify.
  $env:PATH = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:PATH
  $stillMissing = @()
  foreach ($p in $needInstall) { if (-not (& $p.ok)) { $stillMissing += $p.cmd } }
  if ($stillMissing.Count -gt 0) {
    Write-Host (Msg 'reopen') -ForegroundColor Yellow
    return
  }
} elseif ($needInstall.Count -gt 0 -and $DryRun) {
  foreach ($p in $needInstall) { Write-Host ((Msg 'installing') + " " + $p.id + " (dry-run)") -ForegroundColor DarkGray }
}

# --- hand off to the shared bilingual config engine ---
Write-Host (Msg 'nowNode') -ForegroundColor Cyan
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$setup = Join-Path $scriptDir 'scripts\setup.mjs'

# Forward --lang ONLY when the user explicitly chose one, so a plain ./install.ps1
# still shows setup.mjs's interactive language chooser (defaulting to the OS
# locale, which we pass via DISCORD_COPILOT_SDK_LOCALE). --Yes is non-interactive, so pin
# the resolved language there.
$fwd = @()
if ($PSBoundParameters.ContainsKey('Lang') -or $Yes) { $fwd += @('--lang', $L) }
if ($Yes)         { $fwd += '--yes' }
if ($DryRun)      { $fwd += '--dry-run' }
if ($Residency)   { $fwd += '--residency' }
if ($Residency24x7) { $fwd += '--residency-24x7' }
if ($NoResidency) { $fwd += '--no-residency' }
if ($SkipAuth)    { $fwd += '--skip-auth' }
if ($VerbosePreference -ne 'SilentlyContinue') { $fwd += '--verbose' }

& node $setup @fwd
exit $LASTEXITCODE

// Bilingual (Traditional Chinese + English) message engine for the installer.
// Node built-ins only. Pure + unit-tested. The user requirement: default to the
// OS locale, but always let the user choose.

export const LANGS = ["zh", "en"];

const UNKNOWN = "unknown";

/** Detect the preferred installer language from environment locale hints.
 *  install.ps1 sets DISCORD_COPILOT_SDK_LOCALE from Get-Culture on Windows (where LANG is
 *  usually absent); unix shells expose LC_ALL/LC_MESSAGES/LANGUAGE/LANG. Anything
 *  starting with "zh" → Traditional Chinese; otherwise English. */
export function detectLang(env = {}) {
  const hint =
    env.DISCORD_COPILOT_SDK_LOCALE ||
    env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANGUAGE ||
    env.LANG ||
    intlLocale() ||
    "";
  return /^zh/i.test(String(hint)) ? "zh" : "en";
}

function intlLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "";
  } catch {
    return "";
  }
}

/** Normalize a raw --lang value to a supported language, or undefined. */
export function normalizeLang(raw) {
  if (!raw) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "zh" || v.startsWith("zh") || v === "tw" || v === "cht") return "zh";
  if (v === "en" || v.startsWith("en")) return "en";
  return undefined;
}

const MESSAGES = {
  zh: {
    langPrompt: "語言 / Language：[1] 繁體中文  [2] English",
    langChosen: "已選擇語言：繁體中文",
    banner: "discord-copilot-sdk 安裝精靈",
    labWarning:
      "⚠️ 僅限實驗用（v1）：agent 會以你的身分執行 shell 指令並修改檔案，沒有隔離。請只在可拋棄的 VM／測試帳號／測試 repo 上使用。",
    notInRepo: "請在 discord-copilot-sdk 專案根目錄執行（找不到 name=discord-copilot-sdk 的 package.json）。請先 clone 再執行。",
    prereqHeader: "檢查前置需求…",
    prereqNodeOld: "Node 版本過舊（需要 >= 20.19 或 22.12）。目前：",
    prereqMissing: "缺少：",
    prereqOk: "前置需求檢查通過。",
    prereqInstallHint: "請先安裝缺少的項目後重新執行（或使用平台安裝腳本 install.ps1 / install.sh）。",
    authHeader: "檢查 Copilot 登入狀態…",
    authUnknown: "無法確認 Copilot 是否已登入。請執行 `copilot` 然後 `/login` 完成登入後再繼續。",
    authSkip: "已略過 Copilot 登入檢查（--skip-auth）：狀態為「未驗證」，非「已通過」。",
    configHeader: "設定（直接按 Enter 可沿用中括號內的預設值）",
    promptToken: "Discord Bot Token（輸入不會顯示）",
    promptUserIds: "允許使用的 Discord 使用者 ID（逗號分隔，至少一個＝擁有者）",
    promptGuildId: "Discord 伺服器（Guild）ID",
    promptParentChannelId: "初始工作頻道 ID（永遠啟用；可在執行期間啟用其他工作頻道，建議使用私密頻道）",
    promptReposRoot: "repos 根目錄的絕對路徑（裡面放你的各個 repo，例如 C:\\Source\\Repos）",
    promptDefaultRepo: "預設 repo 名稱（可選；留空則 /new 每次都要指定 repo）",
    promptDevGuildId: "開發用 Guild ID（可選，填了可即時註冊斜線指令）",
    promptModel: "預設模型",
    promptContextTier: "context 層級（default / long_context）",
    promptRepoSkills: "預設載入 repo 內的 skills（true / false；repo 作者可影響 agent context）",
    promptUserSkills: "預設載入 ~/.copilot/skills（true / false）",
    errRequired: "此為必填項目。",
    errSnowflake: "必須是 Discord 雪花 ID（5–25 位數字）。",
    errUserIds: "必須是逗號分隔的雪花 ID，至少一個。",
    errRepoMissing: "路徑不存在或不是資料夾：",
    errRepoNotAbsolute: "必須是絕對路徑（例如 C:\\Source\\Repos），不能用相對路徑，Windows 的 C:repos 也不算：",
    errReposRootIsRepo:
      "這個路徑本身就是一個 git repo。REPOS_ROOT 要填的是「裝了好幾個 repo 的上層資料夾」（例如 C:\\Source\\Repos，而不是 C:\\Source\\Repos\\my-repo）：",
    errReposRootTrustOverlap:
      "這個路徑與 bot 自己的狀態目錄重疊（互為上下層）。那會讓 agent 的工作目錄以核准規則的儲存位置為祖先，或讓核准儲存區變成可被綁定的 repo。請換一個不相干的位置：",
    errRepoName: "必須是 REPOS_ROOT 底下的單一名稱（不能有 / 或 \\，也不能有 ..）。",
    errRemovedKey: "這個設定鍵已移除，請改用 REPOS_ROOT／DEFAULT_REPO（或 /repo dev），並從 .env 刪掉這一行。",
    errCloneHostPolicy: "只能是 github 或 allowlist。",
    errCloneAllowlistEmpty: "REPO_CLONE_HOST_POLICY=allowlist 時，REPO_CLONE_ALLOWED_HOSTS 至少要填一個主機。",
    errCloneTimeout: "必須是 10000 到 3600000 之間的整數毫秒。",
    errBotRunning:
      "bot 正在執行中，無法安裝（npm 會需要覆寫它正在使用的檔案）。請先執行 ./stop-bot.ps1（或 ./stop-bot.sh）再重跑安裝器。執行中的 PID：",
    errContextTier: "只能是 default 或 long_context。",
    errSkillSourceSwitch: "只能是 true 或 false（須小寫）。",
    repoLabWarn: "提醒：這些 repo 會被 agent 直接修改，請確定它們是可拋棄的。",
    writingEnv: "寫入 .env…",
    migratedKeys: "已自動轉換舊設定：",
    backedUp: "已備份既有 .env 為",
    wroteEnv: "已寫入 .env（權限僅限本人；token 不會顯示）。",
    envUnchanged: ".env 無變更。",
    buildHeader: "安裝相依套件並建置…",
    buildSkipDry: "（--dry-run）略過 npm ci 與 build。",
    healthOk: "設定載入健檢通過。",
    healthFail: "設定驗證失敗（寫入前已中止，未變更 .env）：",
    residencyPrompt: "是否設定常駐（登入後自動啟動並保持存活；登出即停止）？[y/N]",
    residency247Prompt:
      "要改成**真正的 24/7**（開機即啟動，不需登入）嗎？這需要 Windows 保存你的帳號密碼（存於認證管理員，僅供此工作使用；不會寫入任何檔案或 .env）。[y/N]",
    residency247User: "要以哪個帳號執行（預設 ",
    residency247Pw: "該帳號的 Windows 密碼（輸入時不會顯示）：",
    residency247NoTty: "⚠️ 非互動模式無法安全詢問密碼，已改用「登入後保活」。要 24/7 請在互動終端機重跑並加 --residency-24x7。",
    residency247NoPw: "⚠️ 未輸入密碼，已改用「登入後保活」。",
    residency247Mac:
      "⚠️ macOS 無法在登入前以你的身分執行（LaunchAgent 綁定登入，LaunchDaemon 會以 root 執行 agent 的指令），因此僅設定為登入後保活。",
    residencyWin247: "已註冊 Windows 排程工作（24/7，開機即啟動）：",
    residencyWin: "已註冊 Windows 排程工作（登入後保活）：",
    residencyMac: "已產生 launchd plist 並載入（僅登入後；未在真機驗證，實驗性）：",
    residencyLinux: "已產生 systemd --user 服務並啟用（開機前常駐需 enable-linger；實驗性）：",
    residencySkip: "已略過常駐設定。",
    residencyDry: "（--dry-run）僅顯示常駐計畫，未實際註冊：",
    doneHeader: "✅ 安裝完成",
    doneVersion: "版本：",
    doneStart: "啟動：",
    doneStop: "停止：",
    doneLog: "查看記錄：",
    doneLogAfterStart: "第一次啟動後：{0}",
    doneLogResidency: "若啟用常駐：{0}",
    doneUpdate: "更新：",
    doneUninstall: "解除安裝：",
    doneManual: "最後一步（需手動）：到 Discord 你的頻道送一則測試訊息或用 /new 開始。",
    doneSafety: "安全提醒：使用私人伺服器、開啟 2FA，且切勿把 .env／token 提交到版控。",
    dryNote: "（--dry-run：不會變更任何檔案或系統狀態。）",
    updateActiveThreads:
      "警告：有 {0} 個可恢復 thread、{1} 個髒 worktree，{2} 個無法讀取的 session store。Windows 上更新會硬砍進行中的 turn。",
    updateConfirm: "仍要更新嗎？[y/N] ",
    updateRestoreDone: "已還原更新前的執行狀態。",
    updateCancelled: "已在 active-thread guard 取消更新。",
    updateSourceIdentity: "discord-copilot-sdk {0} ({1})",
    updateRoot: "  root {0}",
    updateCheckout: "  checkout {0} ({1})",
    updateRequested: "  requested {0} -> {1} @ {2}",
    updateAlreadyCurrent: "已是最新版本：{0} ({1})。",
    updatePendingRestore: "警告：上一次更新仍等待 --restore；bot 保持停止。",
    updateAvailable: "有可用更新：{0} ({1}) -> {2} ({3})。",
    updateApplyHint: "套用更新：{0}",
    updateTargetNotes: "{0} 版更新摘要：",
    updatePhaseStop: "[1/4] 停止",
    updatePhaseSource: "[2/4] 套用原始碼",
    updatePhaseSetup: "[3/4] 執行 setup",
    updatePhaseRestore: "[4/4] 還原執行狀態",
    updateRestoreSummary: "正在還原 {0} 的儲存狀態：root {1}、原始碼 {2}、建立於 {3}。",
    updateForeignRestoreState: "略過 {0} 的儲存狀態；它屬於 root {1}。",
    updateStopped: "  {0} bot 已停止（原 PID {1}）。",
    updateResidencyDisabled: "  {0} 常駐服務已停用。",
    updateResidencyNotRegistered: "  {0} 未註冊常駐服務，略過。",
    updateResidencyWasDisabled: "  {0} 常駐服務原本即為停用，維持停用。",
    updateResidencyRestored: "  {0} 常駐服務已重新啟用。",
    updateNotRunningBefore: "  {0} 更新前未執行，維持停止（未自動啟動）。",
    updateRestarted: "  {0} bot 已重新啟動並確認存活（PID {1}）。",
    updateNoRestartInstance: "  {0} 依 --no-restart 保持停止。手動啟動：{1}",
    updateDryRun: "Dry run：會 fetch、驗證新設定、先停止每個 bot 的常駐服務、移動 HEAD、執行 setup，再還原原本狀態。",
    updateManagedDangling: "警告：managed checkout 有 {0} 個即將失去 ref 的 commit。",
    updateApplied: "原始碼已更新：{0} ({1}) -> {2} ({3})。",
    updateNoRestart: "更新成功；依 --no-restart 保持停止。",
    updateComplete: "更新完成，已還原更新前的執行狀態。",
    updateFailed: "更新未完成；bot 保持停止，沒有自動還原。修正原因後執行 node scripts/update.mjs --restore。",
    yes: "是",
    no: "否",
    missingRequiredNonInteractive: "非互動模式下缺少必填項目，且沒有可用的既有值。缺少：",
  },
  en: {
    langPrompt: "語言 / Language: [1] 繁體中文  [2] English",
    langChosen: "Language set to: English",
    banner: "discord-copilot-sdk installer",
    labWarning:
      "⚠️ LAB-ONLY (v1): the agent runs shell commands and edits files as you, with no isolation. Use only on a disposable VM / test account / throwaway repo.",
    notInRepo: "Run this from the discord-copilot-sdk repo root (no package.json with name=discord-copilot-sdk found). Clone it first.",
    prereqHeader: "Checking prerequisites…",
    prereqNodeOld: "Node is too old (need >= 20.19 or 22.12). Found: ",
    prereqMissing: "Missing: ",
    prereqOk: "Prerequisites OK.",
    prereqInstallHint: "Install the missing items and re-run (or use the platform script install.ps1 / install.sh).",
    authHeader: "Checking Copilot sign-in…",
    authUnknown: "Couldn't confirm Copilot is signed in. Run `copilot` then `/login`, then continue.",
    authSkip: "Skipped Copilot auth check (--skip-auth): status is 'unverified', not 'ok'.",
    configHeader: "Configuration (press Enter to keep the [default] in brackets)",
    promptToken: "Discord bot token (input hidden)",
    promptUserIds: "Allowed Discord user IDs (comma-separated, at least one = owner)",
    promptGuildId: "Discord guild (server) ID",
    promptParentChannelId: "Seed work channel ID (always enabled; additional work channels can be enabled at runtime; use private channels)",
    promptReposRoot: "Absolute path to your repos root (the folder that holds your repos, e.g. C:\\Source\\Repos)",
    promptDefaultRepo: "Default repo name (optional; leave blank to require `repo:` on every /new)",
    promptDevGuildId: "Dev guild ID (optional; enables instant slash-command registration)",
    promptModel: "Default model",
    promptContextTier: "Context tier (default / long_context)",
    promptRepoSkills: "Load repository skills by default (true / false; repo authors can influence agent context)",
    promptUserSkills: "Load ~/.copilot/skills by default (true / false)",
    errRequired: "This field is required.",
    errSnowflake: "Must be a Discord snowflake id (5–25 digits).",
    errUserIds: "Must be comma-separated snowflake ids, at least one.",
    errRepoMissing: "Path does not exist or is not a directory: ",
    errRepoNotAbsolute:
      "Must be an absolute path (e.g. /home/you/repos or C:\\Source\\Repos), not a relative one — and Windows drive-relative C:repos does not count: ",
    errReposRootIsRepo:
      "This path is itself a git repo. REPOS_ROOT must be the folder that CONTAINS your repos (e.g. C:\\Source\\Repos, not C:\\Source\\Repos\\my-repo): ",
    errReposRootTrustOverlap:
      "This path overlaps the bot's own state directory (one contains the other). That would either put every agent's working directory below the store that holds your approval rules, or make that store bindable as a repo. Pick an unrelated location: ",
    errRepoName: "Must be a single name under REPOS_ROOT (no / or \\, and no '..').",
    errRemovedKey:
      "This key was removed. Use REPOS_ROOT / DEFAULT_REPO (or `/repo dev`) instead, and delete the old line from .env.",
    errCloneHostPolicy: "Must be 'github' or 'allowlist'.",
    errCloneAllowlistEmpty:
      "REPO_CLONE_ALLOWED_HOSTS must name at least one host when REPO_CLONE_HOST_POLICY=allowlist.",
    errCloneTimeout: "Must be an integer number of milliseconds between 10000 and 3600000.",
    errBotRunning:
      "The bot is running, so this install cannot proceed (npm would have to overwrite files it holds open). Run ./stop-bot.sh (or ./stop-bot.ps1) first, then re-run the installer. Running PID: ",
    errContextTier: "Must be 'default' or 'long_context'.",
    errSkillSourceSwitch: "Must be lowercase 'true' or 'false'.",
    repoLabWarn: "Note: the agent edits these repos directly — make sure they're disposable.",
    writingEnv: "Writing .env…",
    migratedKeys: "Migrated old settings: ",
    backedUp: "Backed up existing .env to ",
    wroteEnv: "Wrote .env (owner-only permissions; token not echoed).",
    envUnchanged: ".env unchanged.",
    buildHeader: "Installing dependencies and building…",
    buildSkipDry: "(--dry-run) skipping npm ci and build.",
    healthOk: "Config-load health check passed.",
    healthFail: "Config validation failed (aborted before writing; .env unchanged): ",
    residencyPrompt: "Set up residency (auto-start + keepalive while logged in; stops at logout)? [y/N]",
    residency247Prompt:
      "Upgrade to **true 24/7** (starts at boot, no login needed)? Windows must store your account password for this (in Credential Manager, scoped to the task; never written to any file or .env). [y/N]",
    residency247User: "Which account should it run as (default ",
    residency247Pw: "Windows password for that account (input is hidden): ",
    residency247NoTty:
      "⚠️ A password cannot be asked for safely in non-interactive mode; using login-keepalive instead. For 24/7, re-run in an interactive terminal with --residency-24x7.",
    residency247NoPw: "⚠️ No password entered; using login-keepalive instead.",
    residency247Mac:
      "⚠️ macOS cannot run as you before login (a LaunchAgent is login-bound; a LaunchDaemon would run the agent's shell commands as root), so this is login-keepalive only.",
    residencyWin247: "Registered Windows Scheduled Task (24/7, starts at boot): ",
    residencyWin: "Registered Windows Scheduled Task (login-keepalive): ",
    residencyMac: "Generated + loaded launchd plist (login-only; not verified on real hardware, experimental): ",
    residencyLinux: "Generated + enabled systemd --user service (pre-login needs enable-linger; experimental): ",
    residencySkip: "Skipped residency setup.",
    residencyDry: "(--dry-run) residency plan only, nothing registered: ",
    doneHeader: "✅ Installation complete",
    doneVersion: "Installed version: ",
    doneStart: "Start: ",
    doneStop: "Stop: ",
    doneLog: "View logs: ",
    doneLogAfterStart: "after the first start, {0}",
    doneLogResidency: "if residency is enabled, {0}",
    doneUpdate: "Update: ",
    doneUninstall: "Uninstall: ",
    doneManual: "Final step (manual): send a test message in your Discord channel, or use /new to begin.",
    doneSafety: "Safety: use a private server, enable 2FA, and never commit .env / your token.",
    dryNote: "(--dry-run: no files or system state will be changed.)",
    updateActiveThreads:
      "Warning: {0} resumable thread(s), {1} dirty worktree(s), and {2} unreadable session store(s) exist. Windows updates hard-kill an in-flight turn.",
    updateConfirm: "Continue with the update? [y/N] ",
    updateRestoreDone: "Restored the pre-update running state.",
    updateCancelled: "Update cancelled at the active-thread guard.",
    updateSourceIdentity: "discord-copilot-sdk {0} ({1})",
    updateRoot: "  root {0}",
    updateCheckout: "  checkout {0} ({1})",
    updateRequested: "  requested {0} -> {1} @ {2}",
    updateAlreadyCurrent: "Already up to date: {0} ({1}).",
    updatePendingRestore: "Warning: a failed update still awaits --restore; the bot remains stopped.",
    updateAvailable: "Update available: {0} ({1}) -> {2} ({3}).",
    updateApplyHint: "Apply it with: {0}",
    updateTargetNotes: "Target release notes for {0}:",
    updatePhaseStop: "[1/4] Stop",
    updatePhaseSource: "[2/4] Apply source",
    updatePhaseSetup: "[3/4] Run setup",
    updatePhaseRestore: "[4/4] Restore running state",
    updateRestoreSummary: "Restoring saved state for {0}: root {1}, source {2}, created {3}.",
    updateForeignRestoreState: "Skipping saved state for {0}; it belongs to root {1}.",
    updateStopped: "  {0} bot stopped (previous PID {1}).",
    updateResidencyDisabled: "  {0} residency has been disabled.",
    updateResidencyNotRegistered: "  {0} has no registered residency; skipping it.",
    updateResidencyWasDisabled: "  {0} residency was already disabled; leaving it disabled.",
    updateResidencyRestored: "  {0} residency has been re-enabled.",
    updateNotRunningBefore: "  {0} was not running before the update; leaving it stopped.",
    updateRestarted: "  {0} bot restarted and verified live (PID {1}).",
    updateNoRestartInstance: "  {0} remains stopped because of --no-restart. Start manually: {1}",
    updateDryRun:
      "Dry run: would fetch, validate the incoming config, stop residency before every bot, move HEAD, run setup, then restore the prior state.",
    updateManagedDangling: "Warning: managed checkout has {0} commit(s) about to lose their ref.",
    updateApplied: "Source updated: {0} ({1}) -> {2} ({3}).",
    updateNoRestart: "Update succeeded; --no-restart leaves it stopped.",
    updateComplete: "Update complete; the prior running state has been restored.",
    updateFailed:
      "Update did not complete; the bot remains stopped and was not restored automatically. Fix the cause, then run node scripts/update.mjs --restore.",
    yes: "yes",
    no: "no",
    missingRequiredNonInteractive: "Non-interactive mode is missing required fields with no existing value. Missing: ",
  },
};

/** Look up a message for `lang`, falling back to English then the key itself
 *  (so a missing key can never crash the installer). */
export function t(key, lang) {
  const l = LANGS.includes(lang) ? lang : "en";
  const table = MESSAGES[l] || MESSAGES.en;
  if (key in table) return table[key];
  if (key in MESSAGES.en) return MESSAGES.en[key];
  return key;
}

/** Substitute numbered placeholders without hiding an incomplete operator message. */
export function formatMessage(template, values) {
  if (!Array.isArray(values)) throw new TypeError("message values must be an array");
  return String(template).replace(/\{(\d+)\}/g, (_, indexText) => {
    const index = Number(indexText);
    const value = values[index];
    if (value === undefined) throw new Error(`missing message value {${index}}`);
    return String(value);
  });
}

/** All message keys (for parity checks/tests). */
export function messageKeys() {
  return Object.keys(MESSAGES.en);
}

export { MESSAGES };
export { UNKNOWN };

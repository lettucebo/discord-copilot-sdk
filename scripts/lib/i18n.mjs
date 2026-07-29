// Bilingual (Traditional Chinese + English) message engine for the installer.
// Node built-ins only. Pure + unit-tested. The user requirement: default to the
// OS locale, but always let the user choose.

export const LANGS = ["zh", "en"];

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
    promptParentChannelId: "父頻道 ID（只有此頻道下建立的 thread 會被接受，建議用私密頻道）",
    promptRepoPath: "受控 repo 的絕對路徑（唯一允許被操作的可拋棄 repo）",
    promptDevGuildId: "開發用 Guild ID（可選，填了可即時註冊斜線指令）",
    promptModel: "預設模型",
    promptContextTier: "context 層級（default / long_context）",
    errRequired: "此為必填項目。",
    errSnowflake: "必須是 Discord 雪花 ID（5–25 位數字）。",
    errUserIds: "必須是逗號分隔的雪花 ID，至少一個。",
    errRepoMissing: "路徑不存在或不是資料夾：",
    errContextTier: "只能是 default 或 long_context。",
    repoLabWarn: "提醒：這個 repo 會被 agent 直接修改，請確定它是可拋棄的。",
    writingEnv: "寫入 .env…",
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
    doneStart: "啟動：",
    doneStop: "停止：",
    doneLog: "查看記錄：",
    doneManual: "最後一步（需手動）：到 Discord 你的頻道送一則測試訊息或用 /new 開始。",
    doneSafety: "安全提醒：使用私人伺服器、開啟 2FA，且切勿把 .env／token 提交到版控。",
    dryNote: "（--dry-run：不會變更任何檔案或系統狀態。）",
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
    promptParentChannelId: "Parent channel ID (only threads under it are honored; use a private channel)",
    promptRepoPath: "Absolute path to the controlled repo (the ONE disposable repo it may touch)",
    promptDevGuildId: "Dev guild ID (optional; enables instant slash-command registration)",
    promptModel: "Default model",
    promptContextTier: "Context tier (default / long_context)",
    errRequired: "This field is required.",
    errSnowflake: "Must be a Discord snowflake id (5–25 digits).",
    errUserIds: "Must be comma-separated snowflake ids, at least one.",
    errRepoMissing: "Path does not exist or is not a directory: ",
    errContextTier: "Must be 'default' or 'long_context'.",
    repoLabWarn: "Note: the agent edits this repo directly — make sure it's disposable.",
    writingEnv: "Writing .env…",
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
    doneStart: "Start: ",
    doneStop: "Stop: ",
    doneLog: "View logs: ",
    doneManual: "Final step (manual): send a test message in your Discord channel, or use /new to begin.",
    doneSafety: "Safety: use a private server, enable 2FA, and never commit .env / your token.",
    dryNote: "(--dry-run: no files or system state will be changed.)",
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

/** All message keys (for parity checks/tests). */
export function messageKeys() {
  return Object.keys(MESSAGES.en);
}

export { MESSAGES };

# discord-copilot-sdk — 安裝指南 / Installation Guide

> ⚠️ **僅限實驗環境 (v1) / LAB-ONLY (v1)**
> discord-copilot-sdk 讓 Discord 直接控制你本機的 GitHub Copilot：agent 會**以你的身分執行 shell 指令並修改檔案**，v1 沒有隔離。請**只**在可拋棄的 VM／測試帳號／測試 repo 上使用。
> discord-copilot-sdk lets Discord drive your local GitHub Copilot: the agent **runs shell commands and edits files as you**, with no isolation in v1. Use **only** on a disposable VM / test account / throwaway repo.

安裝器是**雙語的**（繁體中文 + English）：預設依你的作業系統語系顯示，並且可以自己選。
The installer is **bilingual** (Traditional Chinese + English): it defaults to your OS locale and lets you choose.

---

## 1. 前置需求 / Prerequisites

- **Node.js** ≥ 20.19（或 ≥ 22.12）/ Node.js ≥ 20.19 (or ≥ 22.12)
- **git**
- **GitHub Copilot CLI**（`copilot`）— 已用 `copilot` → `/login` 登入 / signed in via `copilot` then `/login`
- 一個 **Discord bot token**、你的 **Discord user ID**、目標 **guild ID** 與 **父頻道 ID**（建議私密頻道）/ a Discord bot token, your user ID, the target guild ID, and a parent channel ID (private channel recommended)

> 🤖 **還沒有 bot？** 請先看 [`docs/DISCORD-SETUP.md`](docs/DISCORD-SETUP.md) —— 建立 bot、開啟必要的 Message Content Intent、用正確權限邀請、取得上面四個值。
> 🤖 **No bot yet?** Start with [`docs/DISCORD-SETUP.md`](docs/DISCORD-SETUP.md) — create the bot, enable the required Message Content Intent, invite it with the right permissions, and collect the four values above.

> 安裝器可以幫你自動安裝 Node / git / Copilot CLI（Windows 用 winget、macOS 用 brew、Linux 用 apt/dnf）。
> The installer can auto-install Node / git / Copilot CLI (winget on Windows, brew on macOS, apt/dnf on Linux).

---

## 2. 最快：一行安裝 / Fastest: one-line install

不需要先 clone，這行會裝好 git、抓下原始碼，然後直接進入設定精靈。
No clone needed — this ensures git, fetches the source, and drops you into the wizard.

> ⚠️ **這個 repo 目前是 private**，所以 `raw.githubusercontent.com` 會回 404。請用下面的 `gh` 版本（會用你已登入的 GitHub 認證）。
> ⚠️ **This repo is currently private**, so `raw.githubusercontent.com` returns 404. Use the `gh` form below — it uses your existing GitHub login.

### Windows (PowerShell)

```powershell
& ([scriptblock]::Create((gh api repos/lettucebo/discord-copilot-sdk/contents/get.ps1 -H "Accept: application/vnd.github.raw" | Out-String)))
```

要帶旗標時接在後面 / Append flags directly:

```powershell
& ([scriptblock]::Create((gh api repos/lettucebo/discord-copilot-sdk/contents/get.ps1 -H "Accept: application/vnd.github.raw" | Out-String))) -Residency24x7
```

### macOS / Linux (bash)

```bash
gh api repos/lettucebo/discord-copilot-sdk/contents/get.sh -H "Accept: application/vnd.github.raw" | bash
gh api repos/lettucebo/discord-copilot-sdk/contents/get.sh -H "Accept: application/vnd.github.raw" | bash -s -- --residency-24x7
```

### 更簡單的等效做法 / Simpler equivalent

```bash
gh repo clone lettucebo/discord-copilot-sdk && cd discord-copilot-sdk && ./install.ps1   # or ./install.sh
```

### 若這個 repo 改為 public / If this repo is made public

```powershell
irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
```

可用環境變數 / Env overrides：`DISCORD_COPILOT_SDK_DIR`（安裝位置，預設 `~/discord-copilot-sdk`）、`DISCORD_COPILOT_SDK_REF`（分支或標籤，預設 `main`）。

> 目錄已存在且是本專案 → 自動更新；已存在但**不是**本專案且非空 → 拒絕覆蓋。
> Existing checkout → updated in place; a non-empty directory that isn't ours → refused, never overwritten.

---

## 2b. 或手動取得原始碼 / Or get the code manually

```bash
git clone https://github.com/lettucebo/discord-copilot-sdk.git
cd discord-copilot-sdk
```

---

## 3. 執行安裝器 / Run the installer

### Windows (PowerShell)

```powershell
./install.ps1
```

語言旗標與其他選項 / Language flag and options:

```powershell
./install.ps1 -Lang zh        # 強制繁體中文 / force Traditional Chinese
./install.ps1 -Lang en        # force English
./install.ps1 -Yes            # 非互動（用既有 .env／預設）/ non-interactive (uses existing .env/defaults)
./install.ps1 -DryRun         # 只預覽，不變更任何東西 / preview only, no changes
./install.ps1 -Residency      # 一併設定常駐（登入後保活）/ residency (login-keepalive)
./install.ps1 -Residency24x7  # 真 24/7（開機即啟動，需存 Windows 密碼）/ true 24/7 (stores a Windows password)
./install.ps1 -NoResidency    # 略過常駐 / skip residency
./install.ps1 -SkipAuth       # 略過 Copilot 登入檢查（標為未驗證）/ skip auth check (marked unverified)
```

### macOS / Linux (bash)

```bash
bash install.sh               # 或 ./install.sh（若已 chmod +x）
bash install.sh --lang zh     # 強制繁體中文 / force Traditional Chinese
bash install.sh --lang en     # force English
bash install.sh --yes         # non-interactive
bash install.sh --dry-run     # preview only
bash install.sh --residency   # login/user auto-start
bash install.sh --skip-auth
```

> 請**不要**用 `sudo` 執行安裝器（只有套件安裝會在需要時提權）。
> Do **not** run the installer with `sudo` (only package installs elevate when needed).

安裝器會：偵測前置需求 → 收集設定並**驗證** → `npm ci` + build → 用真實 schema 在記憶體驗證設定 → **最後**才安全寫入 `.env`（權限僅限本人、token 不顯示、原子寫入 + 備份）→（可選）設定常駐 → 完成報告。（先建置再寫入，`.env` 是最後一步；**全新安裝**時 npm 過程中磁碟上不會有 token。）
The installer will: detect prerequisites → collect + **validate** config → `npm ci` + build → validate the config in memory against the real schema → **finally** write `.env` securely (owner-only, token never echoed, atomic write + backup) → (optional) residency → done report. (Build first, `.env` written last; on a **fresh install** npm never sees the token on disk.)

---

## 4. 常駐 — 兩種，差很多 / Residency — two different things

安裝器會分開問。**預設是登入後保活**，只有你明確選擇才會用到密碼。
The installer asks separately. **Login-keepalive is the default**; a password is only involved if you explicitly choose 24/7.

| | 登入後保活（預設）<br>login-keepalive | **真 24/7**<br>`-Residency24x7` / `--residency-24x7` |
|---|---|---|
| 何時啟動 / starts | 你登入時 / at your logon | **開機時，不需登入** / at boot, no login |
| 登出後 / after logout | **停止** / stops | 繼續執行 / keeps running |
| 需要密碼 / password | 否 / no | Windows：**是** / yes |
| 平台 / platforms | Windows / macOS / Linux | Windows、Linux（macOS 不行 / not macOS） |

### 為什麼 24/7 需要密碼？/ Why does 24/7 need a password?

**不是**因為 Copilot 無法用 token 認證 —— SDK 其實有 `gitHubToken` 選項，是這個 app 自己寫死了 `useLoggedInUser: true`（`src/copilot/sdk.ts`）。

真正的原因是**檔案身分**：agent 會在 `CONTROLLED_REPO_PATH` 執行指令、改檔案，並在你家目錄下建立 git worktree。換一個帳號執行會把這些檔案的擁有者搞亂；用 SYSTEM 執行則等於讓任意指令以 SYSTEM 身分跑 —— 對一個「agent 以你的身分執行 shell 指令」的工具來說更糟。

Windows 要在**無人登入**時以某個使用者身分執行，就必須讓排程工作持有該帳號的密碼。這是 Windows 的規則，不是 Copilot 的限制。

It is **not** because Copilot cannot authenticate with a token — the SDK does
expose `gitHubToken`; this app hardcodes `useLoggedInUser: true`
(`src/copilot/sdk.ts`). The real reason is **file ownership**: the agent runs
commands and edits files in `CONTROLLED_REPO_PATH` and creates git worktrees
under your home directory. Another account would scramble ownership across all of
it, and SYSTEM would run arbitrary commands as SYSTEM — worse for a tool whose
security note is "the agent runs shell commands as you". Running as a user with
nobody logged in is what Windows requires a stored password for.

### 先考慮這個：登入後鎖定螢幕 / Consider this first: stay logged in, lock the screen

如果你只是要「人不在的時候繼續跑」，**登入後保活 + 鎖定螢幕**就夠了 —— 沒有任何密碼被儲存，桌面也是鎖住的。它唯一做不到的是**重開機後自動恢復**。

If you only need "keep running while I'm away", **login-keepalive plus a locked
screen** is enough: no stored secret, no unlocked desktop. The only thing it does
not survive is a reboot. Choose 24/7 only when unattended reboots matter.

> 密碼交給 **Windows 認證管理員**，**不會**寫進任何檔案、`.env` 或指令列。安裝器用隱藏輸入詢問，並透過子行程環境變數傳給 PowerShell —— 因為 `schtasks /RP` 和 `powershell -Command "…$pw…"` 都會把密碼留在指令列，機器上任何程序都能讀到。
> 誠實補充：子行程環境**不是**密文通道 —— 同使用者的程序仍可透過 `ReadProcessMemory` 讀取 PEB，管理員／SYSTEM 更不受限。它只是比指令列少了「隨手可見」這一層。
> The password goes to **Windows Credential Manager** and is **never** written to
> a file, `.env`, or a command line: the installer reads it with hidden input and
> passes it through the child process environment, because `schtasks /RP` and
> `powershell -Command "…$pw…"` both leave secrets in argv where any process can
> read them via `Win32_Process`. To be honest about the limit: a child
> environment is **not** a secret channel — a same-user process can still recover
> it from the PEB via `ReadProcessMemory`, and admins/SYSTEM more easily. It
> removes the casual exposure, not a determined one.

> 換 Windows 密碼後，排程工作會失效，必須重跑安裝器重新註冊。
> After a Windows password change the task's stored credential goes stale and the
> task fails until you re-run the installer.

> **非互動絕不升級 / Non-interactive never escalates**：`--yes`／CI／管線輸入下無法安全詢問密碼，因此即使加了 `--residency-24x7` 也會退回登入後保活並明講原因。
> With `--yes`, in CI, or through a pipe there is no safe way to ask, so `--residency-24x7` falls back to login-keepalive and says so.

- **Windows**：排程工作 `discord-copilot-sdk-<instance>`（失敗自動重啟、無執行時間上限、不會重複啟動）。
  - 停止 / Stop：`schtasks /End /TN discord-copilot-sdk-default`
  - 移除 / Remove：`schtasks /Delete /TN discord-copilot-sdk-default /F`
  - 記錄 / Log：`~/.discord-copilot-sdk/logs/discord-copilot-sdk-default.log`
- **Linux**：`~/.config/systemd/user/discord-copilot-sdk-<instance>.service`；24/7 會自動執行 `loginctl enable-linger`（不需密碼）。
- **macOS**：僅登入後保活。LaunchAgent 綁定登入，LaunchDaemon 以 root 執行會讓 Copilot 變成未登入 —— 兩者都無法在登入前以你的身分執行，所以這裡不會謊稱 24/7。
  `~/Library/LaunchAgents/com.discord-copilot-sdk.<instance>.plist`

> macOS／Linux 常駐**尚未在真機驗證，屬實驗性**。/ macOS/Linux residency is **experimental, not verified on real hardware**.

多重部署 / Multiple deployments：設定 `DISCORD_COPILOT_SDK_INSTANCE_ID`（預設 `default`），常駐資源名稱會隨之改變。

### 手動啟動／停止 / Start and stop by hand

```powershell
./run-bot.ps1      # 背景啟動（已在跑就拒絕）/ start detached (refuses if already running)
./run-bot.ps1 -Foreground
./stop-bot.ps1     # 讀 app 自己寫的 lock / reads the app's own lock
```

```bash
./run-bot.sh
./run-bot.sh --foreground
./stop-bot.sh
```

---

## 5. 最後一步（手動）/ Final step (manual)

到你的 Discord 頻道用 `/new` 開一個 session，或直接送一則訊息測試。
In your Discord channel, run `/new` to start a session, or send a message to test.

---

## 6. 安全提醒 / Safety

- 使用**私人** Discord 伺服器、開啟 **2FA**。/ Use a **private** Discord server, enable **2FA**.
- **絕不**把 `.env` 或 token 提交到版控（已在 `.gitignore`；安裝器也會拒絕寫入被追蹤的 `.env`）。
  **Never** commit `.env` or your token (already in `.gitignore`; the installer refuses to write into a tracked `.env`).
- `.env` 備份存放於 `~/.discord-copilot-sdk/env-backups/`（權限僅限本人）。/ `.env` backups live under `~/.discord-copilot-sdk/env-backups/` (owner-only).

---

## 7. 疑難排解 / Troubleshooting

- **裝完 Node 但終端機找不到** / Node installed but shell can't find it → 關閉並重新開啟終端機再執行一次 / close and reopen the terminal, then re-run.
- **Copilot 未登入** / Copilot not signed in → 執行 `copilot`，然後 `/login`。/ run `copilot`, then `/login`.
- **PowerShell 執行原則** / execution policy → 用 `powershell -ExecutionPolicy Bypass -File ./install.ps1`。
- **重跑安裝器** / re-running → 安全且冪等：會以既有 `.env` 為預設、先備份再寫入。/ safe and idempotent: uses your existing `.env` as defaults and backs it up before writing.

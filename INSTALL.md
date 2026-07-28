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

> 安裝器可以幫你自動安裝 Node / git / Copilot CLI（Windows 用 winget、macOS 用 brew、Linux 用 apt/dnf）。
> The installer can auto-install Node / git / Copilot CLI (winget on Windows, brew on macOS, apt/dnf on Linux).

---

## 2. 取得原始碼 / Get the code

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
./install.ps1 -Residency      # 一併設定登入自動啟動 / also set up login auto-start
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

## 4. 24/7 常駐（可選）/ 24/7 residency (optional)

> **誠實說明 / Honest scope**：目前的常駐是「**登入後自動啟動並保持存活**」（Windows 排程工作 at-logon／macOS LaunchAgent／Linux systemd `--user`）。真正的「登入前無人值守」需要額外步驟（Linux 的 `loginctl enable-linger`）。macOS／Linux 的常駐**尚未在真機驗證，屬實驗性**。
> The current residency is **auto-start + keepalive while you are logged in** (Windows Scheduled Task at-logon / macOS LaunchAgent / Linux systemd `--user`). True pre-login unattended startup needs extra steps (`loginctl enable-linger` on Linux). macOS/Linux residency is **experimental and not verified on real hardware**.

- **Windows**：註冊排程工作 `discord-copilot-sdk-<instance>`（**登入後**啟動並保持存活、失敗自動重啟、無執行時間上限）。
  - 停止 / Stop：`schtasks /End /TN discord-copilot-sdk-default`
  - 移除 / Remove：`schtasks /Delete /TN discord-copilot-sdk-default /F`
  - 記錄 / Log：`~/.discord-copilot-sdk/logs/discord-copilot-sdk-default.log`
- **macOS**：`~/Library/LaunchAgents/com.discord-copilot-sdk.<instance>.plist`
- **Linux**：`~/.config/systemd/user/discord-copilot-sdk-<instance>.service`（登入前常駐：`loginctl enable-linger $USER`）

多重部署 / Multiple deployments：設定 `DISCORD_COPILOT_SDK_INSTANCE_ID`（預設 `default`），常駐資源名稱會隨之改變。

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

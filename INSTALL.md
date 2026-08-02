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

### Windows (PowerShell)

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF)))
```

> ⚠️ **不要用 `irm ... | iex`** —— `get.ps1` 帶 UTF-8 BOM（PowerShell 5.1 從磁碟執行時需要它），而 `Invoke-RestMethod` 在 PowerShell 5.1 **與** 7 都不會從回應內容去除這個 BOM。`iex`／`[scriptblock]::Create()` 解析的是字串而非檔案，未去除的 BOM 會黏在 `#Requires` 上，直接讓腳本解析失敗（兩行紅字錯誤）。加上 `iex` 本身在呼叫者的作用域求值，頂層 `param()` 會退化成變數宣告，也完全無法帶旗標——所以上面這個「去 BOM 再用 scriptblock 呼叫」的形式是唯一支援的用法，帶旗標一樣可以：
> ⚠️ **Do not use `irm ... | iex`.** `get.ps1` ships with a UTF-8 BOM (PowerShell 5.1 needs it to parse the file from disk), and `Invoke-RestMethod` does **not** strip that BOM from the response body on **either** PowerShell 5.1 or 7. `iex` / `[scriptblock]::Create()` parse a raw string, not a file, so the untrimmed BOM lands on the `#Requires` token and the script fails to parse outright (two red errors). `iex` also evaluates in the caller's scope, where a top-level `param()` degenerates into variable declarations, so it cannot take flags either way. The form above — strip the BOM, then invoke the scriptblock — is the only supported form, and it takes flags fine:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF))) -Residency24x7
```

### macOS / Linux (bash)

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash -s -- --residency-24x7
```

### 更簡單的等效做法 / Simpler equivalent

```bash
git clone https://github.com/lettucebo/discord-copilot-sdk.git && cd discord-copilot-sdk && ./install.sh   # 或 ./install.ps1
```

### 私有 fork / For a private fork

若你 fork 成 private，`raw.githubusercontent.com` 會回 404，改用 `gh`（會用你已登入的 GitHub 認證）：
If you fork this privately, `raw.githubusercontent.com` returns 404 — use `gh`, which uses your existing GitHub login:

```powershell
& ([scriptblock]::Create(((gh api repos/<owner>/discord-copilot-sdk/contents/get.ps1 -H "Accept: application/vnd.github.raw" | Out-String).TrimStart([char]0xFEFF))))
```

```bash
gh api repos/<owner>/discord-copilot-sdk/contents/get.sh -H "Accept: application/vnd.github.raw" | bash
```

> PowerShell 5.1 與 7 都不會從原生命令輸出中去除 BOM，所以不管是 `irm` 還是 `gh` 形式都需要 `.TrimStart([char]0xFEFF)`；`get.ps1` 帶 BOM 是因為從磁碟執行時 PowerShell 5.1 需要它。
> Neither PowerShell 5.1 nor 7 strips a BOM from native-command output, so both the `irm` and the `gh` form need `.TrimStart([char]0xFEFF)`; `get.ps1` carries a BOM because PowerShell 5.1 needs one when the file is run from disk.

可用環境變數 / Env overrides：`DISCORD_COPILOT_SDK_DIR`（安裝位置，預設 `~/discord-copilot-sdk`）、`DISCORD_COPILOT_SDK_REF`（分支或標籤，預設 `main`）。也可以用 `-Dir <path>` / `--dir <path>` 在指令上直接指定安裝位置。
Env overrides: `DISCORD_COPILOT_SDK_DIR` (install location, default `~/discord-copilot-sdk`), `DISCORD_COPILOT_SDK_REF` (branch/tag, default `main`). You can also pass `-Dir <path>` / `--dir <path>` on the command line to set it directly.

### 資料夾選擇 / Folder selection

沒有指定 `-Dir`／`--dir`／環境變數時，且終端機是互動式的（沒有加 `-Yes`／`--yes`／`-y`），啟動器會偵測**目前目錄（或其上層）是否已經是本專案的 checkout**，並顯示選單：

```
[1] 使用現有的 <你目前的 checkout 路徑>（預設，不會更新）
[2] 安裝到 <預設路徑>
[3] 自訂路徑
```

Without `-Dir`/`--dir`/the env var, and in an interactive terminal (no `-Yes`/`--yes`/`-y`), the bootstrapper detects whether your **current directory (or an ancestor) is already a checkout of this repo** and shows a menu:

```
[1] Use existing <path to your current checkout> (default, not updated)
[2] Install to <default path>
[3] Custom path
```

> ⚠️ **選 [1] 絕對不會 fetch 或 checkout** —— 直接原封不動用你現有的 checkout 交給安裝器，避免把你正在開發用的分支（例如 `main`）意外變成 detached HEAD。只有預設路徑／自訂路徑（選項 [2]、[3]，或 `-Dir`／環境變數）才會用「已存在就 fetch + 切到最新」的方式更新 —— 這些是啟動器自己管理的安裝目錄，不是你的工作副本。
> ⚠️ **Choosing [1] never fetches or checks out** — it hands your existing checkout to the installer exactly as it stands, so it can never accidentally detach HEAD off a branch you're actively developing on (e.g. `main`). Only the default/custom-path options ([2], [3], or `-Dir`/the env var) update via "fetch + checkout latest if already present" — those are directories the bootstrapper itself manages, not your working copy.

非互動執行（`-Yes`／`--yes`／`-y`，或沒有終端機，例如 CI）**不會偵測、不會提示**，一律用預設路徑，行為不隨你執行時所在的目錄改變。
A non-interactive run (`-Yes`/`--yes`/`-y`, or no tty — e.g. CI) **never detects or prompts** — it always uses the default path, so scripted invocations behave the same regardless of the caller's cwd.

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

> **公司管理／受限帳號可能直接被拒絕**：部分企業管理的 Windows 機器（觀察到帳號雖列在 Administrators 但標示「for deny only」）會讓 `Register-ScheduledTask` 回傳「Access is denied」。安裝器會印出警告並**繼續完成其餘設定**（`.env`／build 已經完成，不會因為常駐這個選配步驟而整個失敗），你仍可用 `./run-bot.ps1` 手動啟動。
> **A corporate-managed or restricted account may simply be denied**: on some enterprise-managed Windows machines (observed with an account listed in Administrators but marked "for deny only"), `Register-ScheduledTask` returns "Access is denied". The installer prints a warning and **still completes the rest of setup** (`.env`/build already succeeded, so this optional step failing does not fail the whole install) — you can still start it manually with `./run-bot.ps1`.

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

## 6. 完整解除安裝 / Complete uninstall

```powershell
./uninstall.ps1 -DryRun      # 只看計畫，什麼都不動 / plan only, changes nothing
./uninstall.ps1              # 顯示計畫 → 詢問 → 執行 / plan, confirm, then remove
```

```bash
./uninstall.sh --dry-run
./uninstall.sh
```

| 旗標 / Flag | 作用 / Effect |
| --- | --- |
| `-DryRun` / `--dry-run` | 只印計畫 / print the plan only |
| `-Yes` / `--yes` | 不詢問 / skip the confirmation |
| `-KeepConfig` / `--keep-config` | 保留 `.env`（**你的 bot token 會留在磁碟上**）/ keep `.env` (**your bot token stays on disk**) |
| `-KeepState` / `--keep-state` | 保留 `~/.discord-copilot-sdk` |
| `-Branches` / `--branches` | 一併刪除 `copilot/t-*` 分支（**只刪已合併的**）/ also delete `copilot/t-*` branches (**merged only**) |

### 會移除 / Removed

1. 常駐設定（**所有 instance** 的排程工作／launchd／systemd）＋ 產生的啟動包裝腳本
2. 執行中的 bot（所有 instance；過期的 lock 會被忽略）
3. 該 Discord 伺服器的 slash commands
4. per-session 的 git worktree —— **只移除 git 能證明乾淨的**
5. `~/.discord-copilot-sdk`：核准紀錄（「永遠允許」）、session 記錄、日誌、`.env` 備份
6. 改名前的 `~/.discopilot`
7. `.env` —— **含你的 bot token**

### 絕不會碰 / Never touched

| 項目 | 原因 |
| --- | --- |
| 你的 `CONTROLLED_REPO_PATH` repo | 那是你的程式碼；這個工具只曾在裡面加 worktree 和分支 |
| `~/.copilot` | Copilot CLI 的登入狀態屬於 CLI，不屬於這個工具 |
| node / git / Copilot CLI | 只是前置需求，整台機器共用 |
| Discord 應用程式本身 | 只有你能刪：<https://discord.com/developers/applications> |

### 設計上的取捨 / Deliberate trade-offs

- **預設會刪掉 `.env`**。你要的是「完整」解除安裝，而 bot token 是整包東西裡最敏感的一項；留著它再宣稱「已解除安裝」是假話。要重裝方便就加 `-KeepConfig`，屆時會明確告訴你 token 還在。
  **`.env` goes by default**: the token is the most sensitive artifact here, and calling it "uninstalled" while the token sits on disk would be a half-truth. `-KeepConfig` is the escape hatch, and it says so at the end.
- **分支預設保留**。分支上可能有只存在於那裡的 commit。`--branches` 也只用 `git branch -d`（不是 `-D`），所以 git 會自己擋下未合併的分支。
  Branches are kept by default because they can hold commits that exist nowhere else; `--branches` uses `git branch -d`, never `-D`, so git itself refuses the unmerged ones.
- **解除註冊 slash commands 一定排在刪 `.env` 之前**，因為那需要 token，而 token 的唯一一份就在 `.env` 裡。
  Deregistering the slash commands is ordered before deleting `.env`, because it needs the token and `.env` is its only copy.
- **不會自動刪掉這份原始碼**：腳本正在裡面執行。結尾會告訴你路徑，由你自己移除。
  The checkout is not deleted automatically — the script is running from inside it. The path is printed at the end.

> 沒有互動終端機（CI、管線）又沒有 `--yes` 時，**什麼都不會做**並說明原因。
> With no interactive terminal and no `--yes`, it changes nothing and says why.

### 誠實的邊界 / What "complete" does NOT mean

這個腳本做的是**本機**解除安裝。以下是它做不到、會在結尾明確告訴你的：
This is a **local** uninstall. These are the things it cannot do, and says so at the end:

- **刪 `.env` 不等於註銷 token**。已外流的 token 依然有效 —— 請到 Discord 開發者後台**重設或刪除應用程式**（結尾會印出你這個 app 的確切網址）。
  Deleting `.env` does not revoke the token; a leaked copy still works. Reset it or delete the application (the exact URL for your app is printed at the end).
- **bot 仍是該伺服器的成員**，先前的討論串與訊息也還在。
  The bot remains a guild member, and its threads and messages remain.
- **`~/.copilot/session-state/` 內的 Copilot session 資料不會被刪** —— 那屬於 Copilot CLI。
  Copilot's own session data under `~/.copilot/session-state/` is not deleted — it belongs to the CLI.
- **原始碼（含 `node_modules`、`dist`）不會自刪**，因為腳本正在裡面執行；結尾會印出路徑。
  The checkout (with `node_modules` and `dist`, usually the largest residue) is not self-deleted.
- **agent 曾在你 repo 內做過的任何事**都不會被回復 —— 它本來就是以你的身分執行無沙箱指令。
  Nothing the unsandboxed agent did inside your repo is undone.

> ⚠️ **有兩份 clone 時要注意**：狀態目錄是所有 instance 共用的，所以在 A 執行會刪掉 B 也在用的狀態、並停掉 B 的 bot，但 **B 的 `.env`（含 token）不會被碰**。結尾會提醒你這件事。
> ⚠️ **Two checkouts:** the state dir is shared, so running this in A removes state B also uses and stops B's bot — but **B's `.env`, and its token, is untouched**. The closing report says so.

> 任何一步失敗（例如解除註冊 slash commands 時斷網），腳本會印出 **`Uninstall INCOMPLETE`**、**保留 `.env`**（那是唯一能重試的憑證）並以 **exit code 1** 結束。修好後重跑即可。
> If any step fails — say the network drops while deregistering — it prints **`Uninstall INCOMPLETE`**, **keeps `.env`** (the only credential that could retry), and exits **1**. Re-run when fixed.

---

## 7. 安全提醒 / Safety

- 使用**私人** Discord 伺服器、開啟 **2FA**。/ Use a **private** Discord server, enable **2FA**.
- **絕不**把 `.env` 或 token 提交到版控（已在 `.gitignore`；安裝器也會拒絕寫入被追蹤的 `.env`）。
  **Never** commit `.env` or your token (already in `.gitignore`; the installer refuses to write into a tracked `.env`).
- `.env` 備份存放於 `~/.discord-copilot-sdk/env-backups/`（權限僅限本人）。/ `.env` backups live under `~/.discord-copilot-sdk/env-backups/` (owner-only).

---

## 8. 疑難排解 / Troubleshooting

- **裝完 Node 但終端機找不到** / Node installed but shell can't find it → 關閉並重新開啟終端機再執行一次 / close and reopen the terminal, then re-run.
- **Copilot 未登入** / Copilot not signed in → 執行 `copilot`，然後 `/login`。/ run `copilot`, then `/login`.
- **PowerShell 執行原則** / execution policy → 用 `powershell -ExecutionPolicy Bypass -File ./install.ps1`。
- **重跑安裝器** / re-running → 安全且冪等：會以既有 `.env` 為預設、先備份再寫入。/ safe and idempotent: uses your existing `.env` as defaults and backs it up before writing.

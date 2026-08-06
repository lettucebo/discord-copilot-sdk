# discord-copilot-sdk — 安裝指南

> [English](INSTALL.md) · **繁體中文**

> ⚠️ **僅限實驗環境 (v1)**
> discord-copilot-sdk 讓 Discord 直接控制你本機的 GitHub Copilot：agent 會**以你的身分執行 shell 指令並修改檔案**，v1 沒有隔離。請**只**在可拋棄的 VM／測試帳號／測試 repo 上使用。

安裝器是**雙語的**（繁體中文 + 英文）：預設依你的作業系統語系顯示，並且可以自己選。

---

## 1. 前置需求

- **Node.js** ≥ 20.19（或 ≥ 22.12）
- **git**
- **GitHub Copilot CLI**（`copilot`）— 已用 `copilot` → `/login` 登入
- 一個 **Discord bot token**、你的 **Discord user ID**、目標 **guild ID** 與 **父頻道 ID**（建議私密頻道）

> 🤖 **還沒有 bot？** 請先看 [`docs/DISCORD-SETUP.zh-TW.md`](docs/DISCORD-SETUP.zh-TW.md) —— 建立 bot、開啟必要的 Message Content Intent、用正確權限邀請、取得上面四個值。

> 安裝器可以幫你自動安裝 Node / git / Copilot CLI（Windows 用 winget、macOS 用 brew、Linux 用 apt/dnf）。

---

## 2. 最快：一行安裝

不需要先 clone，這行會裝好 git、抓下原始碼，然後直接進入設定精靈。

### Windows (PowerShell)

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF)))
```

> ⚠️ **不要用 `irm ... | iex`** —— `get.ps1` 帶 UTF-8 BOM（PowerShell 5.1 從磁碟執行時需要它），而 `Invoke-RestMethod` 在 PowerShell 5.1 **與** 7 都不會從回應內容去除這個 BOM。`iex`／`[scriptblock]::Create()` 解析的是字串而非檔案，未去除的 BOM 會黏在 `#Requires` 上，直接讓腳本解析失敗（兩行紅字錯誤）。加上 `iex` 本身在呼叫者的作用域求值，頂層 `param()` 會退化成變數宣告，也完全無法帶旗標——所以上面這個「去 BOM 再用 scriptblock 呼叫」的形式是唯一支援的用法，帶旗標一樣可以：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF))) -Residency24x7
```

### macOS / Linux (bash)

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash -s -- --residency-24x7
```

### 更簡單的等效做法

```bash
git clone https://github.com/lettucebo/discord-copilot-sdk.git && cd discord-copilot-sdk && ./install.sh   # 或 ./install.ps1
```

### 私有 fork

若你 fork 成 private，`raw.githubusercontent.com` 會回 404，改用 `gh`（會用你已登入的 GitHub 認證）：

```powershell
& ([scriptblock]::Create(((gh api repos/<owner>/discord-copilot-sdk/contents/get.ps1 -H "Accept: application/vnd.github.raw" | Out-String).TrimStart([char]0xFEFF))))
```

```bash
gh api repos/<owner>/discord-copilot-sdk/contents/get.sh -H "Accept: application/vnd.github.raw" | bash
```

> PowerShell 5.1 與 7 都不會從原生命令輸出中去除 BOM，所以不管是 `irm` 還是 `gh` 形式都需要 `.TrimStart([char]0xFEFF)`；`get.ps1` 帶 BOM 是因為從磁碟執行時 PowerShell 5.1 需要它。

可用環境變數：`DISCORD_COPILOT_SDK_DIR`（安裝位置，預設 `~/discord-copilot-sdk`）、`DISCORD_COPILOT_SDK_REF`（分支或標籤，預設 `main`）。也可以用 `-Dir <path>` / `--dir <path>` 在指令上直接指定安裝位置。

### 資料夾選擇

沒有指定 `-Dir`／`--dir`／環境變數時，且終端機是互動式的（沒有加 `-Yes`／`--yes`／`-y`），啟動器會偵測**目前目錄（或其上層）是否已經是本專案的 checkout**，並顯示選單：

```
[1] 使用現有的 <你目前的 checkout 路徑>（預設，不會更新）
[2] 安裝到 <預設路徑>
[3] 自訂路徑
```

> ⚠️ **選 [1] 絕對不會 fetch 或 checkout** —— 直接原封不動用你現有的 checkout 交給安裝器，避免把你正在開發用的分支（例如 `main`）意外變成 detached HEAD。只有預設路徑／自訂路徑（選項 [2]、[3]，或 `-Dir`／環境變數）才會用「已存在就 fetch + 切到最新」的方式更新 —— 這些是啟動器自己管理的安裝目錄，不是你的工作副本。

非互動執行（`-Yes`／`--yes`／`-y`，或沒有終端機，例如 CI）**不會偵測、不會提示**，一律用預設路徑，行為不隨你執行時所在的目錄改變。

> 目錄已存在且是本專案 → 自動更新；已存在但**不是**本專案且非空 → 拒絕覆蓋。

---

## 2b. 或手動取得原始碼

```bash
git clone https://github.com/lettucebo/discord-copilot-sdk.git
cd discord-copilot-sdk
```

---

## 3. 執行安裝器

### Windows (PowerShell)

```powershell
./install.ps1
```

語言旗標與其他選項：

```powershell
./install.ps1 -Lang zh        # 強制繁體中文
./install.ps1 -Lang en        # 強制英文
./install.ps1 -Yes            # 非互動（用既有 .env／預設）
./install.ps1 -DryRun         # 只預覽，不變更任何東西
./install.ps1 -Residency      # 一併設定常駐（登入後保活）
./install.ps1 -Residency24x7  # 真 24/7（開機即啟動，需存 Windows 密碼）
./install.ps1 -NoResidency    # 略過常駐
./install.ps1 -SkipAuth       # 略過 Copilot 登入檢查（標為未驗證）
```

### macOS / Linux (bash)

```bash
bash install.sh               # 或 ./install.sh（若已 chmod +x）
bash install.sh --lang zh     # 強制繁體中文
bash install.sh --lang en     # 強制英文
bash install.sh --yes         # 非互動
bash install.sh --dry-run     # 只預覽
bash install.sh --residency   # 登入／使用者自動啟動
bash install.sh --skip-auth
```

> 請**不要**用 `sudo` 執行安裝器（只有套件安裝會在需要時提權）。

> ⚠️ **`REPOS_ROOT` 必須是「裝著你各個 repo 的上層資料夾」的絕對路徑** —— 例如 `C:\Source\Repos`，而**不是** `C:\Source\Repos\my-repo`。這條規則和舊版的 `CONTROLLED_REPO_PATH` **正好相反**：那個要求你指向一個 repo，這個要求你指向裝著 repo 的那層。安裝器會擋下「這個路徑本身就是 git repo」的情況，因為那正是升級時最容易犯的錯（直接把舊值貼過來）。`REPOS_ROOT` 也不能和 `~/.discord-copilot-sdk` 互為上下層 —— 那會讓 agent 的工作目錄以核准規則的儲存位置為祖先。還沒有可拋棄的 repo 就先建一個：`mkdir -p ~/copilot-sandbox/demo && cd ~/copilot-sandbox/demo && git init`，然後填 `REPOS_ROOT=~/copilot-sandbox`。

> 🔄 **從單一 repo 版本升級**：安裝器會自動轉換舊設定 —— `CONTROLLED_REPO_PATH=C:\Source\Repos\my-repo` 會變成 `REPOS_ROOT=C:\Source\Repos` 加 `DEFAULT_REPO=my-repo`，並把舊的那行從 `.env` 刪掉。舊的鍵留著不刪的話 bot 會拒絕啟動（它們過去定義的是安全邊界，語意已經改變，不能含糊帶過）。

> 重跑安裝器前請先停掉 bot（`./stop-bot.ps1` / `./stop-bot.sh`）—— npm 需要覆寫執行中程序正在使用的檔案。安裝器會偵測到並直接告訴你，不會再丟出難懂的 `EPERM` 錯誤。

安裝器會：偵測前置需求 → 收集設定並**驗證** → `npm ci` + build → 用真實 schema 在記憶體驗證設定 → **最後**才安全寫入 `.env`（權限僅限本人、token 不顯示、原子寫入 + 備份）→（可選）設定常駐 → 完成報告。（先建置再寫入，`.env` 是最後一步；**全新安裝**時 npm 過程中磁碟上不會有 token。）

---

## 3b. 更新既有安裝

請用更新器，不要重跑 `install.*`。它同樣使用共用的設定／建置引擎，但會先處理手動 `git pull && npm install` 容易做錯的生命週期順序。

### 一行網路啟動器

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.ps1).TrimStart([char]0xFEFF)))
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.sh | bash
```

網路形式會把最新更新 engine 下載到私有暫存目錄。engine 會在改動目標 checkout **之前**先停常駐與 bot，所以 bootstrap 不會覆寫 live bot 正在使用的檔案。更新器刻意只信任本 upstream origin；即使可用 `gh api` 取得 bootstrap，v1 仍不支援更新 private fork。

### 本機命令與保證

```powershell
./update.ps1 -Check
./update.ps1 -DryRun
./update.ps1 -Ref refs/tags/v0.1.0
./update.ps1 -AllInstances
./update.ps1 -Restore
```

```bash
./update.sh --check
./update.sh --dry-run
./update.sh --ref refs/tags/v0.1.0
./update.sh --all-instances
./update.sh --restore
```

`--check` 不寫入任何東西；要求的 ref 已等於 HEAD 時 exit `0`、不同時 `2`、fail-closed preflight 拒絕時 `1`（例如 dirty checkout 或另一個 live instance）。`--dry-run` 會顯示完整生命週期，但不 fetch、停機、建置、寫入或 checkout。短 ref 同時是 branch/tag 時優先選 branch；用 `--ref refs/tags/v0.1.0` 可消除歧義。annotated tag 比較的是 peeled commit，不是 tag object。

更新器會拒絕 dirty 或無法辨識的 checkout。具名開發分支只有在先證明 ancestor 關係後，才用 `git merge --ff-only` 更新；bootstrap 管理的 detached checkout 則 depth-one fetch 後 detach 到 `FETCH_HEAD`。它會掃描所有 live instance lock，若有其他 instance 正在跑，必須顯式傳入 `--all-instances` 才能改動共用 source。

apply 順序是：唯讀 preflight → 停常駐 → 停 bot → 移動 source → `setup.mjs --yes --skip-auth --no-residency` → 還原。既有常駐只會重新 enable/start，絕不重新 register，所以 Windows 24/7 task 不會悄悄降成登入後保活。

> ⚠️ source 已變更後若 setup 失敗，更新器會刻意讓 bot 保持停止、保留 `~/.discord-copilot-sdk/update-state.<instance>.json`，並印出 `--restore` 指令。Windows 停止是硬終止，進行中的 turn 可能遺失。先查看 active thread/worktree，只有確定可中斷時才確認 guard（或使用 `--yes`）。
> 未處理的 restore state 不能被新的 apply 覆蓋；在 `--restore` 解決前，`--check` 與 `--dry-run` 仍是安全的診斷方式。

### 發版

`--version` 會顯示 app SemVer、commit SHA 與已安裝的 Copilot SDK。`CHANGELOG.md` 記錄發版變更，從 `0.1.0` 開始；它刻意只用英文，因為一個 tag 只產生一份 GitHub Release。workflow 會自動產生 GitHub Release notes。先寫好 `[Unreleased]`，再從乾淨工作樹明確執行 `npm run release -- <version>`。helper 會 commit 版本／changelog 並建立 annotated `v<version>`；推送 branch 與 tag 後才會發布 release workflow。

---

## 4. 常駐 — 兩種，差很多

安裝器會分開問。**預設是登入後保活**，只有你明確選擇才會用到密碼。

| | 登入後保活（預設） | **真 24/7**<br>`-Residency24x7` / `--residency-24x7` |
|---|---|---|
| 何時啟動 | 你登入時 | **開機時，不需登入** |
| 登出後 | **停止** | 繼續執行 |
| 需要密碼 | 否 | Windows：**是** |
| 平台 | Windows / macOS / Linux | Windows、Linux（macOS 不行） |

### 為什麼 24/7 需要密碼？

**不是**因為 Copilot 無法用 token 認證 —— SDK 其實有 `gitHubToken` 選項，是這個 app 自己寫死了 `useLoggedInUser: true`（`src/copilot/sdk.ts`）。真正的原因是**檔案身分**：agent 會在 `REPOS_ROOT` 底下的 repo 執行指令、改檔案，並在你家目錄下建立 git worktree。換一個帳號執行會把這些檔案的擁有者搞亂；用 SYSTEM 執行則等於讓任意指令以 SYSTEM 身分跑 —— 對一個「agent 以你的身分執行 shell 指令」的工具來說更糟。Windows 要在**無人登入**時以某個使用者身分執行，就必須讓排程工作持有該帳號的密碼。這是 Windows 的規則，不是 Copilot 的限制。

### 先考慮這個：登入後鎖定螢幕

如果你只是要「人不在的時候繼續跑」，**登入後保活 + 鎖定螢幕**就夠了 —— 沒有任何密碼被儲存，桌面也是鎖住的。它唯一做不到的是**重開機後自動恢復**。只有無人值守重開機很重要時，才選 24/7。

> 密碼交給 **Windows 認證管理員**，**不會**寫進任何檔案、`.env` 或指令列。安裝器用隱藏輸入詢問，並透過子行程環境變數傳給 PowerShell —— 因為 `schtasks /RP` 和 `powershell -Command "…$pw…"` 都會把密碼留在指令列，機器上任何程序都能透過 `Win32_Process` 讀到。誠實補充：子行程環境**不是**密文通道 —— 同使用者的程序仍可透過 `ReadProcessMemory` 讀取 PEB，管理員／SYSTEM 更不受限。它只是比指令列少了「隨手可見」這一層。

> 換 Windows 密碼後，排程工作會失效，必須重跑安裝器重新註冊。

> **非互動絕不升級**：`--yes`／CI／管線輸入下無法安全詢問密碼，因此即使加了 `--residency-24x7` 也會退回登入後保活並明講原因。

> **公司管理／受限帳號可能直接被拒絕**：部分企業管理的 Windows 機器（觀察到帳號雖列在 Administrators 但標示「for deny only」）會讓 `Register-ScheduledTask` 回傳「Access is denied」。安裝器會印出警告並**繼續完成其餘設定**（`.env`／build 已經完成，不會因為常駐這個選配步驟而整個失敗），你仍可用 `./run-bot.ps1` 手動啟動。

- **Windows**：排程工作 `discord-copilot-sdk-<instance>`（失敗自動重啟、無執行時間上限、不會重複啟動）。
  - 停止：`schtasks /End /TN discord-copilot-sdk-default`
  - 移除：`schtasks /Delete /TN discord-copilot-sdk-default /F`
  - 記錄：`~/.discord-copilot-sdk/logs/discord-copilot-sdk-default.log`
- **Linux**：`~/.config/systemd/user/discord-copilot-sdk-<instance>.service`；24/7 會自動執行 `loginctl enable-linger`（不需密碼）。
- **macOS**：僅登入後保活。LaunchAgent 綁定登入，LaunchDaemon 以 root 執行會讓 Copilot 變成未登入 —— 兩者都無法在登入前以你的身分執行，所以這裡不會謊稱 24/7。
  `~/Library/LaunchAgents/com.discord-copilot-sdk.<instance>.plist`

> macOS／Linux 常駐**尚未在真機驗證，屬實驗性**。

多重部署：設定 `DISCORD_COPILOT_SDK_INSTANCE_ID`（預設 `default`），常駐資源名稱會隨之改變。

### 手動啟動／停止

```powershell
./run-bot.ps1      # 背景啟動（已在跑就拒絕）
./run-bot.ps1 -Foreground
./stop-bot.ps1     # 讀 app 自己寫的 lock
```

```bash
./run-bot.sh
./run-bot.sh --foreground
./stop-bot.sh
```

---

## 5. 最後一步（手動）

到你的 Discord 頻道用 `/new` 開一個 session，或直接送一則訊息測試。

---

## 6. 完整解除安裝

```powershell
./uninstall.ps1 -DryRun      # 只看計畫，什麼都不動
./uninstall.ps1              # 顯示計畫 → 詢問 → 執行
```

```bash
./uninstall.sh --dry-run
./uninstall.sh
```

| 旗標 | 作用 |
| --- | --- |
| `-DryRun` / `--dry-run` | 只印計畫 |
| `-Yes` / `--yes` | 不詢問 |
| `-KeepConfig` / `--keep-config` | 保留 `.env`（**你的 bot token 會留在磁碟上**） |
| `-KeepState` / `--keep-state` | 保留 `~/.discord-copilot-sdk` |
| `-Branches` / `--branches` | 一併刪除 `copilot/t-*` 分支（**只刪已合併的**） |

### 會移除

1. 常駐設定（**所有 instance** 的排程工作／launchd／systemd）＋ 產生的啟動包裝腳本
2. 執行中的 bot（所有 instance；過期的 lock 會被忽略）
3. 該 Discord 伺服器的 slash commands
4. per-session 的 git worktree —— **只移除 git 能證明乾淨的**
5. `~/.discord-copilot-sdk`：核准紀錄（「永遠允許」）、session 記錄、日誌、`.env` 備份
6. 改名前的 `~/.discopilot`
7. `.env` —— **含你的 bot token**

### 絕不會碰

| 項目 | 原因 |
| --- | --- |
| `REPOS_ROOT` 底下的每個 repo | 那是你的程式碼；這個工具只曾在裡面加 worktree 和分支 |
| `~/.copilot` | Copilot CLI 的登入狀態屬於 CLI，不屬於這個工具 |
| node / git / Copilot CLI | 只是前置需求，整台機器共用 |
| Discord 應用程式本身 | 只有你能刪：<https://discord.com/developers/applications> |

### 設計上的取捨

- **預設會刪掉 `.env`**。你要的是「完整」解除安裝，而 bot token 是整包東西裡最敏感的一項；留著它再宣稱「已解除安裝」是假話。要重裝方便就加 `-KeepConfig`，屆時會明確告訴你 token 還在。
- **分支預設保留**。分支上可能有只存在於那裡的 commit。`--branches` 也只用 `git branch -d`（不是 `-D`），所以 git 會自己擋下未合併的分支。
- **解除註冊 slash commands 一定排在刪 `.env` 之前**，因為那需要 token，而 token 的唯一一份就在 `.env` 裡。
- **不會自動刪掉這份原始碼**：腳本正在裡面執行。結尾會告訴你路徑，由你自己移除。

> 沒有互動終端機（CI、管線）又沒有 `--yes` 時，**什麼都不會做**並說明原因。

### 誠實的邊界

這個腳本做的是**本機**解除安裝。以下是它做不到、會在結尾明確告訴你的：

- **刪 `.env` 不等於註銷 token**。已外流的 token 依然有效 —— 請到 Discord 開發者後台**重設或刪除應用程式**（結尾會印出你這個 app 的確切網址）。
- **bot 仍是該伺服器的成員**，先前的討論串與訊息也還在。
- **`~/.copilot/session-state/` 內的 Copilot session 資料不會被刪** —— 那屬於 Copilot CLI。
- **原始碼（含 `node_modules`、`dist`）不會自刪**，因為腳本正在裡面執行；結尾會印出路徑。
- **agent 曾在你 repo 內做過的任何事**都不會被回復 —— 它本來就是以你的身分執行無沙箱指令。

> ⚠️ **有兩份 clone 時要注意**：狀態目錄是所有 instance 共用的，所以在 A 執行會刪掉 B 也在用的狀態、並停掉 B 的 bot，但 **B 的 `.env`（含 token）不會被碰**。結尾會提醒你這件事。

> 任何一步失敗（例如解除註冊 slash commands 時斷網），腳本會印出 **`Uninstall INCOMPLETE`**、**保留 `.env`**（那是唯一能重試的憑證）並以 **exit code 1** 結束。修好後重跑即可。

---

## 7. 安全提醒

- 使用**私人** Discord 伺服器、開啟 **2FA**。
- **絕不**把 `.env` 或 token 提交到版控（已在 `.gitignore`；安裝器也會拒絕寫入被追蹤的 `.env`）。
- `.env` 備份存放於 `~/.discord-copilot-sdk/env-backups/`（權限僅限本人）。

---

## 8. 疑難排解

- **裝完 Node 但終端機找不到** → 關閉並重新開啟終端機再執行一次。
- **Copilot 未登入** → 執行 `copilot`，然後 `/login`。
- **PowerShell 執行原則** → 用 `powershell -ExecutionPolicy Bypass -File ./install.ps1`。
- **重跑安裝器** → 安全且冪等：會以既有 `.env` 為預設、先備份再寫入。

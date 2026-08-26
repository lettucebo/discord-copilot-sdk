# discord-copilot-sdk

> [English](README.md) · **繁體中文**

從任何地方（包含手機）透過 Discord 控制你的**本機 GitHub Copilot**，並保留完整的「GitHub Copilot app」體驗。

`discord-copilot-sdk` 是一個 Discord bot，透過官方 [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk)（JSON-RPC）驅動本機 Copilot engine。每個 Discord thread 對應一個 Copilot session；bot 會把 agent 訊息、精簡工具呼叫、預設收合的 thinking 與 todo checklist 依真實時序串流進 thread，並把 permission / choice / plan prompts 呈現成 Discord **按鈕**（自由文字回答則用一般 thread 訊息），讓你可從任何裝置回應。Token 用量與即時 model/effort/context tier 可用 `/usage` 隨時查看。

> 姊妹專案：[`seam-acp`](https://github.com/lettucebo/seam-acp)。seam-acp 透過 ACP protocol 把 Discord 串到多種 agents；**discord-copilot-sdk 只支援 Copilot 且 SDK-native**，因此能提供最完整、最官方的 Copilot 體驗（native ask_user、plan approval、usage、每模型最高約 1M context 的 `contextTier: long_context`）。

## 狀態

**已可 end-to-end 運作並可安裝**（`install.ps1` / `install.sh`，見 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md)）。架構與 phase 歷史在 [`docs/PLAN.md`](docs/PLAN.md)。貢獻者 CI 診斷請見 [`docs/CI-TROUBLESHOOTING.zh-TW.md`](docs/CI-TROUBLESHOOTING.zh-TW.md)。為什麼採用本專案而非現成的 Discord agent 橋接方案、以及為什麼排除 ACP 路線，記錄在 [`docs/HARNESS-EVALUATION.zh-TW.md`](docs/HARNESS-EVALUATION.zh-TW.md)。仍僅限實驗環境——執行前請先閱讀下方安全模型。

### 前身 `discopilot`

專案已更名為 `discord-copilot-sdk`。GitHub 會重新導向舊 repository 名稱，因此 `git clone https://github.com/lettucebo/discopilot.git` 目前仍可運作——但只有在沒有新 repository 取得該名稱前才成立，所以請優先使用目前 URL。（Discord application 本身仍叫 **DisPilot**；該名稱存在於 Discord Developer Portal，而不是這個 repo。）

舊名稱**不會**被當成設定讀取：

| 舊 | 新 |
| --- | --- |
| `~/.discopilot` | `~/.discord-copilot-sdk` |
| `DISCOPILOT_*` | `DISCORD_COPILOT_SDK_*` |

如果 host 上找到任一舊名稱，啟動時會明確指出並告訴你要搬什麼——不會默默讀到錯誤狀態或忽略你的設定。已儲存的 approval rules 也刻意**不會**替你搬移：恢復一個你可能已忘記的「Always (this repo)」授權，是這個專案不會自動做的方向。殘留的 `DISCOPILOT_*` 環境變數仍會從 agent 環境中移除。

## ⚠️ 安全模型（執行前必讀）

discord-copilot-sdk v1 **僅限實驗環境**。它會**以啟動 bot 的使用者身分**執行 shell/file tools，針對受控 repo 操作——v1 沒有 sandbox（隔離 controller/worker 分離延後）。請只在你不介意 agent 修改的可拋棄機器／VM 上執行。

目前已有的緩解措施：

- **逐指令核准**：每個 shell permission 都會顯示成 Discord Allow/Deny card；Allow 只有在 Discord 確認 click 後才 settle，其他 permission kind 與 interactive callback（ask_user / exit-plan / elicitation）都**fail closed**（deny/cancel）。
- **Repo hooks、MCP 設定與 custom instructions 仍停用**：`enableFileHooks:false` 阻止受控 repo 的 `.github/hooks` 在背後以 `resolvedByHook` 自動核准指令。`enableConfigDiscovery:false` 阻止探索 `.mcp.json` / `.vscode/mcp.json`；`skipCustomInstructions:true` 仍不可少，因 SDK 不論 config discovery 都會載入 `AGENTS.md` / `.github/copilot-instructions.md`。
- **Skills 是刻意、較窄的例外**：預設只明確載入 session repo 的 CLI 原生 skill roots：`.github/skills`、`.agents/skills`、`.claude/skills`，以及 `~/.copilot/skills`。這**不會**開啟 broad config/MCP discovery；實測 skill 的 `allowed-tools` frontmatter 也不會繞過 SDK 模式中的 Discord permission card。不過 skill 的名稱與描述即使尚未 invoke 也會進入 model context，因此 repo 作者仍可 steer agent。設 `ENABLE_REPO_SKILLS=false` 可只移除 repo skill roots、保留 user skills；`ENABLE_USER_SKILLS=false` 則相反。
- **抗偽造 cards**：指令會被 escaped 顯示（避免 markdown/code-fence breakout），含 bidirectional/control characters 的指令會自動 deny，過長指令也會自動 deny，而不是只顯示一部分。
- **Access gate**：只有 allow-list user id(s)、在設定的 guild + 已啟用 channel/threads 內，才能驅動 session。（這只 gate *input*；任何能讀 channel 的人都能讀 *output*——請使用私密 channel。）Secrets（`DISCORD_*`/`DISCORD_COPILOT_SDK_*`）會從 agent runtime env 移除。bot 能*讀取*哪些 channel 是 Discord 的決定，而非本 bot：invite 會給 bot 基本權限（因此看得到一般公開 channel），但只把這個 bot 的 application 加進去的**私密 channel** 才是 Discord 原生白名單——不是某 channel 成員的 bot 收不到它的任何內容，slash commands 也不會出現在那裡。推薦模型是私密工作 channel；[`docs/CHANNEL-ACCESS.zh-TW.md`](docs/CHANNEL-ACCESS.zh-TW.md) 是權威模型，[`docs/DISCORD-SETUP.zh-TW.md`](docs/DISCORD-SETUP.zh-TW.md) §4b 說明最小權限組合。在 bot **是**成員的地方隱藏 slash commands，是另一個只能由 admin 設定的 Discord Integrations 覆寫，同樣記錄在 [`docs/CHANNEL-ACCESS.zh-TW.md`](docs/CHANNEL-ACCESS.zh-TW.md)。

**已知限制——繼承的 approvals：** bot 使用你已登入的 Copilot（`~/.copilot`），所以你存在那裡的任何 blanket "always allow" approval rules 都會套用，並繞過每指令 Discord prompt。若要真正展示逐指令核准，請用沒有已儲存 auto-approvals 的 account/home 執行。完整隔離是延後的 controller/worker 分離。

### ⚡ YOLO mode (`/yolo mode:on`) — opt-in，移除核准 gate

`/yolo mode:on` 會讓**單一 thread 的 session**自動核准**所有** permission requests，不顯示 card——包含平常 fail closed 的種類（file writes 等）。它是為「直接完成」跑法存在；也是逐指令核准唯一刻意的例外，因此：

- 它是**per-session**（單一 thread）且**永不 persist**——restart 或 session recovery 都會回到 **OFF**，recovery notice 會明講；
- 啟用只有在 Discord 確認警告後才生效，所以 reply 失敗不會讓 session 默默失去防護；
- 每次 auto-approval 都會先同步 append + fsync 一筆有界紀錄（kind + target，絕不含 payload）到 `~/.discord-copilot-sdk/<instance>.audit.jsonl`，再顯示精簡 timeline 行。Discord render 是 **best effort**，但本機 log 才是權威；若 log 無法寫入，YOLO 與既有規則的自動核准都會拒絕該請求，不會在沒有稽核紀錄下執行；
- 已貼出的一般 permission card 不會因 YOLO 被追溯改寫；檔案傳送卡則不同：開啟 YOLO 會立即撤銷任何待處理的 `discord_send_file` 核准，之後的 agent 送檔請求會快速拒絕並提示改用 `/file`；
- `ask_user` 與 exit-plan 仍會詢問——YOLO 核准的是 *permissions*，不會替你回答問題或選 plan actions；
- `/stop` 仍優先：teardown 不論 YOLO 都 fail closed；
- `/usage` 會顯示 `⚡ YOLO: ON`，讓你一眼看出。用 `/yolo mode:off` 關閉。
- **不要在不理解風險時把 YOLO 與 repo skills 疊加**：repo skill 文字可 steer model，而 YOLO 移除了平時約束 tool use 的 Discord 核准 gate。只要 session 載入 repo skills，啟用警告就會明確指出這一點。

## 為什麼使用 SDK（已驗證）

在真實機器上實測確認（Copilot Enterprise、copilot CLI 1.0.74-1）：

- 可 end-to-end 驅動**本機** session：`listModels()`、`createSession()`、`send()`、完整 event stream（`assistant.message`/`reasoning`/deltas、`tool.execution_*`、`session.usage_info`/`plan_changed`/`idle`）。discord-copilot-sdk 會 render assistant messages、依序的精簡 tool calls，以及預設收合在 Discord spoiler 後的 thinking；reasoning 的 markdown delimiters 會轉成純文字，避免破壞 spoiler。新 session 會請求 detailed reasoning summary；在已測 runtime 中，Claude 可能只提供 opaque summary 而無可顯示內容，GPT reasoning 模型則提供可顯示的 summary。
- Native interactive callbacks：`onPermissionRequest`、`onUserInputRequest`（ask_user）、`onExitPlanMode`、`onElicitationRequest`。
- **`contextTier: "long_context"` 解鎖 936K effective window**（預設 200K）——raw ACP path 做不到（上限 264K）。

## 需求

- Node.js `^20.19.0` 或 `>=22.12.0`
- Host 上已安裝且登入 GitHub Copilot CLI（bot 使用已登入使用者）
- Discord bot token、你的 Discord user id（allow-list）、guild（server）id，以及一個作為首次啟動**種子預設值**（`DISCORD_PARENT_CHANNEL_ID`）的私密文字 channel id

### Skills 與來源開關

每個新 session 都會明確載入下列 roots，同時保持 `enableConfigDiscovery:false`：

| 來源 | 預設 | 開關 |
| --- | --- | --- |
| Repo：`.github/skills`、`.agents/skills`、`.claude/skills` | 開啟 | `ENABLE_REPO_SKILLS` |
| User：`~/.copilot/skills` | 開啟 | `ENABLE_USER_SKILLS` |

兩個開關只接受小寫 `true` / `false`；`.env` 留空會回到 `true`。若所有啟用的 root 都沒有
`SKILL.md`，bot 會移除 `skill` tool，而非留下只會以「Skill not found」失敗的 tool。
git worktree 只看得到已 commit 的 skill；編輯尚未 commit 的 skill 時請用 `/repo dev local`。

`~/.copilot/skills` 是跨 session 共用的。任何被你核准可執行 shell 的 session 都可能寫入其中；
請把它視為受信任的本機狀態，並只在可拋棄的 lab host 上使用。

升級本機 Copilot CLI 後，請跑下列手動 acceptance probe（需要登入）：

```bash
npm run smoke:skills
```

## 快速開始

一行，不需要 clone——確保 git 存在、抓取 source（或如果你已在 checkout 中則重用），然後執行雙語精靈。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.ps1).TrimStart([char]0xFEFF)))
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
```

> ⚠️ Windows 上不要用 `irm ... | iex`——原因與無法帶 flags 的細節見 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md)。

已在此 repo checkout 裡？互動執行時會詢問是否原樣重用該目錄（絕不 fetch/checkout——不會讓你的 `main` detached）。傳入 `-Dir <path>` / `--dir <path>`，或非互動執行（`-Yes`/`--yes`），即可跳過提示。詳情見 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md) 的資料夾選擇章節。

加上 `-Residency24x7` / `--residency-24x7` 也會安裝**真正 24/7** 常駐（開機即啟動，不需登入）。在 Windows，這代表 Scheduled Task 必須保存你的帳號密碼——不是因為 Copilot 無法 headless 認證（SDK 確實提供 `gitHubToken`；此 app 寫死 `useLoggedInUser: true`），而是因為 agent 會以**你**的身分編輯 repo 與 worktrees；Windows 要在沒人登入時以某使用者身分執行，就需要儲存密碼。如果你只需要「離開時繼續跑」，一般 `-Residency` 加鎖定螢幕不需儲存 secret。詳情見 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md) 的常駐章節。

完整指引在 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md)。Discord bot 本身的設定——application、必要的 Message Content intent、invite permissions 與四個 ID——在 [`docs/DISCORD-SETUP.zh-TW.md`](docs/DISCORD-SETUP.zh-TW.md)。

### 檔案傳送

當你要刻意把 session workdir 內、經驗證的檔案上傳回擁有它的 Discord thread 時，用 `/file path:<path>`。agent 也可以提議 `discord_send_file({path,comment?})`；正常情況下它會顯示獨立的 Allow once / Deny 卡片、只能送 workdir 內檔案，且同樣受 Discord 8 MiB 上傳上限限制。這兩條路都需要 Discord 的 **Attach Files** 權限，且所有送檔都會抑制 mentions。YOLO 對檔案卡是刻意的例外：開啟時會撤銷已待處理的送檔卡，並快速拒絕之後的 agent 送檔請求，提示改用 `/file`。

> **平台可用性：** 對外 Discord 檔案傳送僅支援 Windows。在 Linux、macOS 與其他平台，session 和所有非送檔 bot 功能仍會正常運作，但 `/file` 會安全地回覆不可用，且不會暴露 `discord_send_file`。這是刻意的取捨：SDK 只接受 pathname `workingDirectory`，不接受保留的 descriptor，因此 POSIX 無法安全防止 create 或 resume 期間的 swap-and-restore。

從既有 clone：

```bash
cp .env.example .env   # 填入 DISCORD_BOT_TOKEN + DISCORD_ALLOWED_USER_IDS
npm install
npm run dev
```

或設定完成後，用 `./run-bot.ps1` / `./run-bot.sh` detached 啟動，`./stop-bot.ps1` / `./stop-bot.sh` 停止。

## 更新

請用更新器，不要重跑安裝器。它會保留 `.env`、先停常駐再停 bot、驗證即將進來的版本並重新建置；**只有** setup 成功才會還原更新前的執行狀態。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.ps1).TrimStart([char]0xFEFF)))
```

```bash
curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.sh | bash
```

在本機執行可使用安全旗標：

```powershell
./update.ps1 -Check                 # 唯讀；0=已是目前、2=不同、1=preflight 拒絕
./update.ps1 -DryRun                # 完整計畫，但不 fetch、停機、建置或寫入
./update.ps1 -Ref refs/tags/v0.1.0  # 釘在 annotated 或 lightweight release tag
./update.ps1 -AllInstances          # 明確同時處理所有 live 本機 instance
./update.ps1 -Restore               # 在 apply 失敗後還原保留的狀態
```

```bash
./update.sh --check
./update.sh --dry-run
./update.sh --ref refs/tags/v0.1.0
./update.sh --all-instances
./update.sh --restore
```

`--check` 適合做 source 監控：`0` 表示 HEAD 符合要求的 ref，`2` 表示不同，`1` 表示 fail-closed preflight 拒絕、需要人工處理。它不是 runtime 健康檢查；輸出會標示它檢查的精確 root、checkout 與解析後 ref。具名開發分支只有在乾淨且可 fast-forward 時才會更新；dirty、divergent 或無法辨識的 checkout 一律在停機前拒絕。若還有其他 live instance，必須明確加 `--all-instances`。

若 source 已變更後 setup 失敗，更新器會刻意保持 bot 停止，並保留 `~/.discord-copilot-sdk/update-state.<instance>.json`；修正原因後再跑 `--restore`。Windows 停 bot 是硬終止，進行中的 turn 可能遺失。完整生命週期與發版規則見 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md)。
該 restore state 未處理前，新的 apply 會被拒絕；`--check` 與 `--dry-run` 仍可用於診斷。成功更新會報告每個生命週期階段，且只有觀察到新 PID 後才會稱 bot 已重啟；原本已停止的 bot 會維持停止並明講。

## 解除安裝

```powershell
./uninstall.ps1 -DryRun   # 查看會移除什麼，不變更任何東西
./uninstall.ps1           # 顯示計畫、詢問，然後移除全部
```

```bash
./uninstall.sh --dry-run
./uninstall.sh
```

它會移除常駐註冊、執行中的 bot、guild slash commands、per-session worktrees、`~/.discord-copilot-sdk`（approval grants、session records、logs、`.env` backups）以及 `.env` **包含你的 bot token**。

它絕不刪除你的受控 repo、不碰 `~/.copilot`（你的 Copilot CLI login）、不移除 git 無法證明 clean 的 worktree，並保留 `copilot/t-*` branches，除非你傳入 `--branches`——即使如此也只刪已合併分支。`--keep-config` 會保留 `.env`，並清楚說明 token 仍在磁碟上。詳情見 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md)。

## 討論串

每個 `/new` 都會開一個 thread。名稱由便宜的小 model（預設 `gemini-3.5-flash`）從你的第一則訊息產生，並在**沒有 tools 的 throwaway session** 中執行，所以長 prompt 仍會變成短且可讀的名稱，也不會碰到你自己 session 的 history/context。`/rename title:…` 可覆寫；`TITLE_MODEL=off` 會停用 titler，改用截短的第一行。

刻意沒有 `#001` 序號：Discord 已依建立時間排序 channel threads（在 desktop client 驗證——把最新訊息貼到舊 thread 不會讓它排到新 thread 前），數字只會占用 sidebar 寬度。

## 並行 sessions

每個 `/new` thread 都是獨立 session，且會**平行**執行。每個 session 都有自己的 **git worktree**（branch `copilot/t-<threadId>`），所以兩個 agents 同時工作時不會覆寫彼此檔案——已透過同時跑兩個 threads 驗證，每個只寫入自己的 tree，受控 repo 保持不動。

> 這種隔離防的是*意外*互相覆蓋，不是 sandbox。Lab mode 仍以你的 OS user 無沙箱執行 tools，所以被刻意引導的 session（例如受 repo content prompt injection 影響）仍可用 path 存取另一個 session 的 worktree。上方安全模型仍全部適用。

- `/sessions` — 顯示 live sessions、各自 state 與 branch（最多 8 個）。殘留 records 也會列出，並依實際可做的事分成 *clearable*、*will retry on restart*（絕不直接刪除——record 是該 Copilot conversation 唯一 pointer），以及 bot 失去 channel 存取權的紀錄（`thread-no-access`）——這類紀錄在存取權恢復或 restart 後會重試，但擁有者也可以用 `/end thread:<id>` 明確清除。
- `/end` — 結束**此** thread 的 session；其他 session 繼續跑。在 session 已消失但 record 還在的 thread 中，同一指令會清掉該 record 與 worktree。
- `/end thread:<id>` — 最常見殘留是**已刪除**的 thread，你無法在裡面輸入。請改從 parent channel 執行；bot 啟動時也會在那裡貼出 ids，以及任何沒有 record 的 worktree directory。只有 git 證明安全時才移除 worktree——任何 local content、detached HEAD，或 HEAD 在不同 branch，都會保留它，**且 record 會跟著保留**，讓 `/sessions` 仍能顯示磁碟狀態。處理該 tree（`git worktree remove`）後再執行同一指令完成清理。

`/end` 只有在 git 回報 clean 時才移除 worktree。Dirty worktree 會保留並回報 path：未提交工作不是 bot 該丟棄的。若要落地某 session 的成果，請要求它 commit，然後 `git merge copilot/t-<threadId>`。

### 頻道存取 (`/channel`)

Sessions 現在可存在於多個私密 Discord channels。`DISCORD_PARENT_CHANNEL_ID` 是首次啟動的**種子預設值**：它只會在首次啟動時寫入 channel registry，之後就是可移除的一般項目。先把 bot 加入私密 channel，再於該處執行 `/channel enable`，或從已啟用 channel 執行 `/channel enable channel:<id>`。用 `/channel disable` 移除 channel，用 `/channel list` 稽核授權與 Discord 可見度。權威模型見 [`docs/CHANNEL-ACCESS.zh-TW.md`](docs/CHANNEL-ACCESS.zh-TW.md)，完整的私密 channel 設定、啟用與正反向驗收流程見 [`INSTALL.zh-TW.md`](INSTALL.zh-TW.md)。

`/channel list` 會稽核每個**已啟用** channel 的授權與 bot 目前實際看得到的狀態，並回報漂移（已授權但看不見、或看得見但未授權）。Discord 是否在使用者 command picker 顯示 slash commands，是由 channel 成員資格決定，並可另加 admin 專用的 Integrations 覆寫；請見 [`docs/CHANNEL-ACCESS.zh-TW.md`](docs/CHANNEL-ACCESS.zh-TW.md)。

## Repos 與開發模式

`REPOS_ROOT` 是**包含**你的 repos 的資料夾（例如 `C:\Source\Repos`）；`DEFAULT_REPO` 是 `/new` 未傳 `repo:` 時綁定的 repo 名稱。

- `/repo show` — 顯示此 thread 的 repo、mode、branch 與**完整 working directory**。
- `/repo list` — 顯示每個可綁定 repo，並標出保持在 `local` mode 的項目。
- `/repo set <name>` — 重新綁定此 thread（type-to-search）。
- `/repo dev <worktree|local>` — 設定此 session 在哪裡工作。
- `/repo clone <source> [name]` — clone 到 `REPOS_ROOT` 後綁定。
- `/repo new <name>` — 在那裡建立空 repo 後綁定。

**每個新 session 都會取得自己的 worktree。** `local`——agent 直接編輯 repo checkout——只能 per thread 透過 `/repo dev local` 選取。沒有 config key 可把它設成預設，因為那會讓每個 future thread 在沒人決定的情況下編輯你的 working copy。

每個 repo（每個 bot process）最多只能有**一個 live `local` session**。兩個 agents 在同一 checkout 會默默覆寫彼此，而其中一個 `git checkout` 會破壞另一個未提交工作，因此第二個 thread 要求同 repo 時會被拒絕並告知是哪個 thread 持有它。Worktree sessions 沒有此限制——這正是 worktree 的用途。

重新綁定會建立**新的** Copilot session，因為 SDK 在建立 session 時固定 working directory。因此 conversation history 會消失，所以已有 turn 的 thread 會先要求確認。若 turn 正在執行，或目前 worktree 有 uncommitted、untracked 或 ignored content，rebind 會直接被拒絕——rebind 後就沒有任何東西指向該 tree，把它 orphan 會讓每個 command 都無法再觸及。

`/repo clone` 只允許 `https`/`ssh` fetch；除非設定 `REPO_CLONE_HOST_POLICY=allowlist`，否則只允許 `github.com`；也絕不從 internal、loopback 或 metadata address clone。它用 argv array 執行 git（絕不用 shell），停用 `ext::`、`file::` 與 credential helpers，並忽略你的 global git 與 ssh config——`url.<base>.insteadOf` 可重寫 allowed URL，ssh `ProxyCommand` 也能執行程式。刻意沒有「任何 public host」選項：hostname 無法證明 DNS 會指到哪裡。

## Steering 與佇列

當 turn 正在執行時送出的普通訊息會*steer* 該 turn，而不是被丟棄。它會用 runtime 的 `mode: "immediate"` 傳遞，落在下一個 tool-call boundary——實測八個 sequential commands 的 run 在第四個後停止並遵循新指令。若單一長 generation 沒有 boundary，它會在之後立刻執行；不論如何都不會丟掉 in-flight 工作。

`/queue message:…` 會保留 prompt，直到目前 turn 完成後再執行（單獨 `/queue` 會列出 pending；`/queue clear:true` 會清空）。Queue 保存在 **discord-copilot-sdk 內部**，不是交給 runtime 自己的 queue：`abort()` **不會**清空 runtime queue（曾觀察到 queued message 在 abort 後仍執行），所以 `/stop` 無法誠實地宣稱已停止它。目前 `/stop` 會丟棄 queue 並回報丟了幾則。Queue 是 volatile——restart 會忘記——且上限 10。

## 授權

MIT — 見 [LICENSE](LICENSE)。

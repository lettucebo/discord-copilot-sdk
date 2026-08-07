# 執行計畫 v3：discord-copilot-sdk — Discord 前端控制本機 Copilot（SDK-native）

> **v1 目標（收斂後）**：一個 **Discord frontend for a supported local Copilot SDK session** —
> 從手機/Discord 對一個受控 repo 開一個私密 thread、串流看到 Copilot 輸出、對一個 shell 權限請求
> 檢視並 approve/deny、能 abort。**先把最難的部分（安全隔離 + 互動 broker + 串流去重）做對**，其餘後推。
>
> 已納入 RubberDuck 兩輪（rd-plan、rd-plan2）。SDK 事實均型別驗證。

## 0. 已型別驗證的 SDK 事實
- 套件 `@github/copilot-sdk`。**使用最新版 `1.0.7-preview.3`（npm `latest` tag，依使用者要求追蹤最新）** + lockfile + 啟動相容檢查（installed vs declared，declared 取自本專案 package.json）+ 契約測試。
- Callback：`onPermissionRequest` / `onUserInputRequest` / `onElicitationRequest` / `onExitPlanModeRequest`。
- **權限請求有 10 種變體**（已驗證）：`shell, write, read, mcp, url, memory, custom-tool, hook, extension-management, extension-permission-access`。
- **`resolvedByHook?: boolean` 存在** → 本機 hook 可繞過 client handler 自行決定；須偵測並在啟用 approval hook/隱式 policy 時**啟動即失敗**或用隔離設定。
- `streaming` 預設 false（要 delta 須 `streaming:true`）；`continuePendingWork` 存在（初期 false）。
- 無 exit-plan handler → SDK **自動核准**；無 permission handler → **擱置 pending**。→ **每次 create/resume 從第一個可用 session 就註冊全部 4 個 handler**。
- `contextTier:"long_context"` 實測 200K→936K（依模型/policy/帳號/版本；**勿硬寫**，用 `listModels()` capabilities）。

## 1. 安全 / 隔離（Blocking 等級，必做或明確標示 lab-only）
**Containment invariant（強制）**：
> agent 工具執行**不得**讀取 Discord token、授權 DB、稽核金鑰、或無關的本機憑證（SSH/雲端）。

達成方式二選一：
- **A. Controller/Worker 分離**（建議）：controller（bot）持有 Discord token/DB/audit；worker 以**獨立受限 OS 身分**跑 SDK runtime，收到**清洗過的環境**與**僅允許 repo 的 ACL**。
- **B. 明確標示「僅拋棄式 lab 環境」**：若不做隔離，P1 只能用在可拋棄的 VM/帳號，README/啟動時警告。

其他必做：
- 每 session **canonical 化、明確 allowlisted** 的 `workingDirectory`（單一受控 repo 起步）。
- 授權：**user + guild + 父頻道**三重比對；私密 thread/頻道。
- 移除 v2 的「session 級唯讀核准」——**唯讀也能外洩**，`readOnly` 非安全邊界。
- 帳號被盜取捨（明確擇一）：(a) 接受「盜號=控制被隔離的 worker/repo」並**要求 Discord MFA**；或 (b) 對危險核准加**獨立 TOTP/本機 step-up**（非阻塞強化）。
- agent 產生訊息**停用 mention 解析**；視 Discord 為**資料外流出口**（Enterprise 政策 ≠ 可貼專有碼）。

## 2. 權限呈現與決策（fail-closed）
- 對 10 變體做**窮舉 discriminated-union switch**；**未知/新變體一律 deny**。
- callback payload **深拷貝 + canonical 序列化**；以 `{nonce, sessionId, persistentGeneration, messageId, payloadDigest}` 綁定該 resolver。
- Discord customId 只放 namespace/action/random-nonce（不放敏感內容）。
- **先完整公布細節，再啟用核准按鈕**。
- 若無損呈現超過 Discord 限制、或含帶密欄位 → **deny 或要求本機核准**，**絕不截斷後核准**。
- 逃逸 control/BiDi/Markdown 字元；抑制 URL embed。
- 用語修正：卡片顯示的是「**SDK 提供的完整結構化請求**」，**不是「將被執行的內容」**（shell 無法證明副作用；隔離而非卡片處理 script/symlink/DNS/TOCTOU）。
- `resolvedByHook` / approval hook 偵測：啟用時啟動失敗或用隔離 SDK 設定，避免繞過 broker。

## 3. PendingInteractionBroker（明確狀態機，非 boolean）
狀態：`PUBLISHING → OPEN → CLAIMED_ACK → SETTLED`；modal 分支 `OPEN → MODAL_OPEN → CLAIMED_ACK → SETTLED`；終態 `TIMED_OUT` / `ABORTED`。（見 §9.1：實作的自由輸入改用 thread 訊息，未走 Discord modal 分支。）
不變式：
- **CAS/claim 同步發生在任何 await 之前**。
- 核准**只在** Discord ack 成功 + generation 仍有效 + 稽核已 commit **之後**才送達 SDK。
- 短 ack 期限：Discord 失敗即安全 deny。
- **單一 finalizer**：清所有 timer、移除 parent/modal map、abort signal、只 resolve 一次。
- 「自己輸入」以 `showModal()` 為**初次**回應；modal 建**一次性 child nonce + 獨立逾時**；未提交終將安全逾時。**（已由 §9.1 取代：實作改為 thread 訊息自由輸入，行動裝置友善；本條 modal 設計不採用。）**
- nonce **密碼學隨機、絕不重用**；逾時已終結 server 端條目後，遲到點擊安全（停用元件僅美觀）。
- **控制/broker 流量不得排在被 `session.send()`/turn 阻塞的佇列後**（否則 SDK 等的權限卡片卡在同一 turn 後面 → 死鎖）。
- 逾時（實作值）：permission / ask_user / exit-plan 共用 `PERMISSION_TIMEOUT_MS = 5 分`（`session-actor.ts`）。逾時後 permission→`user-not-available`；ask_user→丟出錯誤；exit-plan→`{approved:false}`。elicitation 不等待，直接 `{action:"cancel"}` 並發通知。
- `/stop`：先標 `ABORTING` 並**禁止新註冊** → 安全 settle 既有 → 再 `session.abort()`。

## 4. Session 擁有權、復原與 fencing（移到 P2，但規格先定）
- **generation/incarnation**：原規格設想「持久化、交易式遞增」的全域 epoch。**P2 實作刻意簡化**為
  *in-memory、單一行程內* 的 fence（broker 於 registration 捕捉 generation，settle 時比對；create=+1、
  resume 保留）。理由：崩潰後舊行程／broker／pending 全部消失，崩潰前的 Discord 卡片其 nonce 不在新的
  broker 中，本來就無法 settle（execution-safe）；跨重啟的持久化 epoch 對本 one-session lab 模型無實際
  安全增益。若未來需要，再導入完整持久化 epoch（見 P2 design v2 gap #6）。改以「重啟後失效」nonce 提示
  處理 UX。
- **single-instance guard 移到 P0/P1**（兩個行程會毀掉所有 process-local 原子性假設）。
- 對帳表（reconciliation）：

| SQLite | SDK store | Discord target | 動作 |
|---|---|---|---|
| owned | exists | valid | claim generation 並 resume |
| owned | missing | any | 標 orphaned，**不**默默重建 |
| owned | exists | missing/unauthorized | 標 blocked，**不** resume |
| absent | exists | any | 忽略，**永不**認領/刪除 |

- 生命週期：`CREATING/ACTIVE/BLOCKED/ORPHANED/DELETING/DELETED`；**建立前先保留 DB row**、**刪除前先 tombstone**（崩潰不會復活已刪 session）。
- `continuePendingWork:false` → 舊 in-flight 工具/權限標為 interrupted，**不 rehydrate 舊 broker 條目**；舊卡片一律 expired 拒絕；**崩潰復原保留對話歷史、非中斷的 turn**，絕不自動重試有副作用的工作。
- renderer 遇 message 404 → 視為失去 anchor 並開新訊息；thread 不存在則**根本不 resume**。
- **只操作 bot 擁有的 session id**；絕不曝露/刪除 `client.listSessions()` 任意結果。

## 5. 串流呈現（render state machine）
鍵：`turnId/messageId/toolCallId/agentId`。累積 delta；**持久化 `assistant.message` 為權威最終**（不重複貼）；**過濾 agentId** 只呈現主回應；尾端訊息約 750–1000ms 編輯一次 + turn 末 flush；區塊約 1900 字、凍結；佇列有界（丟中間、保最終）；rate limit 交給 discord.js bucket；工具進度為一則更新中的狀態訊息；原始 reasoning 預設關 opt-in；明確 `streaming:true`。

## 6. SDK Adapter（薄層）
隔離 client/session 生命週期、正規化事件、callback 結果變體、model/context 切換、resume、remote。pin 最新版（1.0.7-preview.3）+ lockfile + 啟動相容檢查 + 對安裝 CLI 契約測試。不做多 provider 抽象。

## 7. 從 seam-acp 移植
**重用小原語**：SerialQueue+順序測試、ChoiceBroker 的 timeout/abort/generation 概念、fence/chunk/flush+golden、附件驗證、SQLite WAL、路徑/repo 選擇、health/single-instance+常駐。
**不移植**：ACP runtime/profiles、ask-user MCP+bearer、手工 model/context 探索、ACP compaction、CLI 權限模式參數、chat 抽象、排程/tunnel/gist、龐大 orchestrator。

## 8. 分階段（重排：最小垂直切片先）
- **P0**：scaffold、config schema、**pin 最新 SDK（1.0.7-preview.3）+ 相容檢查（installed vs declared）**、**single-instance guard**、決定 infiniteSessions 政策、決定隔離方式（A 或 B）。驗收：build+空測綠、啟動連 SDK 並 `listModels()`。
- **P1（真正最小垂直切片）**：
  - 單一 owner/guild/父頻道；單一 canonical allowlisted repo；單一私密 thread/session；**手動佈建的受限 worker 環境**（或標 lab-only）。
  - 一 client + 薄 adapter；簡單有界串流 renderer（delta/final 去重 + 分塊）。
  - **註冊全部 4 個 callback**：shell 權限有 approve-once/deny UI；**其餘 9 變體與所有不支援類型 fail-closed（deny/cancel）**。
  - Broker 處理 approve/deny/timeout/重複點擊/abort 競態（第 3 節狀態機）。
  - `/stop`；最小**持久化核准稽核**。
  - **手動啟動、無 resume**；重啟即標 session/interaction interrupted。
  - **驗收**：手機開 thread → 要求 `git status` → 檢視並 approve/deny **確切請求** → 收到串流輸出 → 成功 abort 一個 turn。
- **P2**：resume + reconciliation（第 4 節）+ generation fencing。
- **P3**：其餘 callback UI（ask_user〔自由輸入以 thread 訊息呈現，非 Discord modal；見 §9.1〕、exit-plan、elicitation、memory/mcp/url… 的呈現）。
- **P4**：pickers（/model /effort /context）、usage。`/mode` **未實作**（Copilot 的 agent mode 由 runtime 決定，discord-copilot-sdk 不提供切換）；`/yolo`、`/rename` 為後續新增。queue/steer 未實作 —— 回合進行中送出的訊息會被**丟棄**並回覆說明，不會排隊。
- **P5**：attachments/images 輸入、todo/plan、changed-file/git diff 摘要。
- **P6**：跨平台 installer + 常駐。

## 9. 測試（針對非同步編排）
fake SDK adapter + fake Discord transport + 決定性 clock。必測：逾時只 settle 一次/過期點擊拒絕；未授權與跨 thread 點擊無法 resolve；ack 失敗即 deny；modal 路徑；同/跨 session 併發亂序；shutdown/abort 清空 pending；generation 過期 callback 不生效；delta/final 去重；sub-agent 不交錯；未知權限變體 fail-closed；resume 對帳四種情形；message 404 新 anchor。Live smoke（P1 驗收）+ Restart smoke（P2）。最小 CI（Node22 Win/Ubuntu）。

### 9.1 §9 涵蓋對照（實作後補記）
| §9 需求 | 涵蓋位置 |
|---|---|
| 逾時只 settle 一次 / 過期點擊拒絕 | `broker.test.ts`（`settles exactly once`、逾時用**決定性 fake clock** `vi.useFakeTimers`）|
| 未授權點擊 | `discord-routing.test.ts`（`isAuthorized` 系列）|
| **跨 thread 點擊無法 resolve** | `discord-routing.test.ts`（`decisionBindsToChannel`）+ `app.ts onButton` 綁定 `pending.sessionKey === interaction.channelId` |
| ack 失敗即 deny | `discord-routing.test.ts`（`resolveButtonAck`）、`session-actor.test.ts`（`settles deny if the card cannot be posted`）|
| **同 / 跨 session 併發亂序** | `broker.test.ts`（`out of order` 同 session + `CROSS-session ... out of order` 跨 session）|
| shutdown/abort 清空 pending | `broker.test.ts`（`abort`）、`session-actor.test.ts`（`stop() ... clears pending`）、`app-stop-flow.test.ts` |
| generation 過期 callback 不生效 | `broker.test.ts`（`stale generation`）|
| delta/final 去重 | `transport.test.ts`（`posts once then edits`）、`turn-render.test.ts` |
| sub-agent 不交錯 | `turn-render.test.ts`（`ignores any sub-agent` / `does not let a sub-agent ... overwrite`）|
| 未知權限變體 fail-closed | `session-actor.test.ts`（`auto-denies a non-shell permission (fail closed)`）|
| resume 對帳四種情形 | `reconcile.test.ts`（14）+ `app-reconcile.test.ts`（9）|
| **message 404 新 anchor** | `render-chunks.ts` + `render-chunks.test.ts`（`RE-ANCHORS ...`、survivor-safety；補貼於尾端，見下方殘留）|
| 最小 CI（Win/Ubuntu、Node 20.19+22.12）| `.github/workflows/ci.yml` |

**設計決策（與 §9 措辭的差異，刻意記錄）：**
- **「modal 路徑」= thread 訊息自由輸入**，非 Discord modal 彈窗。行動裝置友善、無彈窗限制；freeform 能力已實作並測試（`session-actor.test.ts` `freeform message answers (wasFreeform=true)`）。不另做 Discord modal（YAGNI，非使用者需求）。
- **Restart smoke（P2）** 的自動化部分即 `app-reconcile.test.ts`（9 個 app 層 resume 對帳情形，以 fake 驅動）+ `reconcile.test.ts`；真正的「重啟後 live 復原」已於開發時人工驗證（斷線→重啟→喚回暗號 PELICAN-77）。可跑於 CI 的 live-restart 需真實 Discord+Copilot，超出無網路 CI 範圍。
- **安裝器測試框架**（`secure-file`/`setup-core`/`setup-integration`）屬 **P6 安裝器回歸**，另立 issue 追蹤，不計入本 §9（#8）。

**message 404 re-anchor 的已接受殘留（single-owner 取捨，RubberDuck R3/R4）：**
- 偵測到 anchor 被刪除（10008 / 純 404）時，**只在該槽位補貼一則新訊息**（保留內容），**絕不刪除仍存在的其他 anchor**。因此**永不遺失、永不重複**內容。
- 殘留 1（順序）：若使用者手動刪除的是**非最後一則**串流訊息，其補貼會出現在頻道**最尾端**而非原位（Discord 無法插入中間位置）。內容完整，但多 chunk 回覆在該回合可能**讀取順序錯置**（下一回合即恢復）。**非「純美觀」**——對程式碼/散文語意可能造成閱讀困擾，但內容不缺不重。
- 殘留 2（best-effort 渲染，**pre-existing，非 #8 引入**）：如同任何 debounced 渲染，暫時性 edit/delete 失敗會在**下一次 flush 重試**；trim 對未確認刪除的 surplus 會**保留追蹤**（同回合內不會產生未追蹤孤兒）。但若失敗發生在該回合**最後一次 flush**（無後續 flush），可能持續到下一回合：縮短的回覆若保留 anchor 的 edit 失敗會顯示**過期文字**，或 surplus anchor 刪除失敗會**殘留為重複訊息**（resetTurn 於下一回合清空 msgIds）。此需 Discord API 於最後一刻恰好暫時性失敗，僅造成聊天記錄的雜訊；原始 doFlush 亦有相同性質。完整 exactly-once 訊息對帳子系統對本工具**不成比例**，刻意不做。
- 此設計**嚴格優於**修正前行為（原本訊息被刪即丟失該段內容）。刻意**不採用**「刪除並重建整段 suffix」（會在暫時性刪除失敗時遺失比基準更多內容），亦不加有狀態 bounded-retry timer（比例原則）。

## 10. 決策紀錄（已定）
1. **隔離方式 = B（先 lab-only）**：不做 controller/worker 分離；P1 只在**可拋棄的 VM/測試帳號/測試 repo**跑；README + 啟動時明確警告「僅限拋棄式環境」。之後再升級到 A。
2. **帳號盜用 = 先靠 Discord MFA**；TOTP/本機 step-up 列為未來強化（非 v1）。
3. **GitHub repo = private，於 P0 建立**（lettucebo/discord-copilot-sdk）。
4. **SDK = 使用最新版 `1.0.7-preview.3`（npm `latest`；依使用者要求）** + lockfile + 啟動相容檢查（declared 取自 package.json，單一真相來源）。
5. **P1 受控 repo = 可拋棄測試 repo（待定）**：開始 P1 live 測試前指定或另建一個 throwaway repo；**不對重要 repo**。

## 11. RubberDuck 紀錄
- rd-plan（R1）→ 納入：broker、安全、擁有權/復原、測試、render、adapter、範圍、移植。
- rd-plan2（R2）→ 納入：P1/P2 順序修正（handler 從第一 session 全註冊+fail-closed）、containment invariant、10 權限變體 fail-closed + resolvedByHook 防繞過、broker 明確狀態機、resume 持久化 fencing + 對帳表 + 生命週期、single-instance→P0、v1 最小化垂直切片。
- 殘留非阻塞強化（記錄不做）：per-session microVM、hash-chained 稽核、TOTP、DLP 掃描（皆 defense-in-depth）。

## 12. 多 repo + per-thread 開發模式（取代 §1「單一受控 repo」）

### 12.1 動機
單一 `CONTROLLED_REPO_PATH` 讓每個 thread 只能在同一個 repo 的 worktree 裡工作。實測痛點：
使用者要求 clone 一個新專案，agent 只能把它放進自己的 worktree
（`~/.discord-copilot-sdk-worktrees/<threadId>/career-ops`），而使用者期望的是
`C:\Source\Repos\career-ops`。agent 當時的回答「我目前工作環境的根目錄是固定在 …(worktree)…，
並非我這邊設定的通用根目錄」完全正確——那正是規格。

### 12.2 決策
1. **`CONTROLLED_REPO_PATH` → `REPOS_ROOT` + `DEFAULT_REPO`**（取代，非並存）。舊鍵存在即**啟動失敗**。
   - 並存被否決：兩條邊界會讓 `bindingOk` 的前綴檢查長出多個 OR 分支，那是最不該複雜化的地方。
   - `z.object()` 會忽略未知鍵，所以刪掉欄位**不等於**拒絕；需在 parse 前加 legacy-key 檢查。
2. **新 session 一律 `worktree`**；`local` 只能逐 thread 用 `/repo dev local` 開啟。
   - `DEFAULT_DEV_MODE` 被否決：一個讓所有新 thread 預設進 local 的設定鍵，就是這條決策要避免的東西。
3. **改綁 = 新的 SDK session**（`workingDirectory` 是建立時設定，`reconfigure()` 改不了），
   因此**對話歷史必然消失**；已跑過回合的 thread 要按鈕二次確認，沿用 `PendingInteractionBroker`。

### 12.3 安全不變式
- **S1 綁定必須被證明**：`validateBinding()` 用 `git rev-parse --git-common-dir` 嚴格確認 worktree
  屬於記錄宣稱的 repo，並用 `--show-toplevel` 確認 local 模式的 repo 是它自己的 working-tree root
  （`.git` 只是一個「條目」，`.git` **檔案**會指向別的 repo）。git 失敗 = 拒絕，不得 fallback
  （`repoRoot()` 的寬鬆版因此不能當驗證器）。兩側都經 `realpath`，且探測環境會清掉
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`——繼承這些變數的 git 回答的是別的 repo。
  **`/new`、rebind、resume 三條路徑都會呼叫。**
- **S2 雙向不相交**：`REPOS_ROOT` 不得包含、也不得被包含於 `stateDir()` / `worktreeRoot()`。
  大小寫折疊**只在 Windows** 做（Linux 上兩個大小寫不同的路徑是不同目錄，CI 有跑 Ubuntu）。
- **S3 local 租約**：同一 repo 同時只有一個 live local session（**同一個行程內**——見 12.5）。reconcile
  **在任何 resume 之前**先掃描並取得租約，且 transient resume 失敗（記錄刻意留 `active`）時**不釋放**——
  否則另一個 thread 會綁走同一 repo，下次重啟就有兩個 durable 主張者。租約在記錄轉為終局狀態
  （`block` / `session-lost`）與 `reclaim()` 時釋放；`local-conflict` 無法持久化時**啟動失敗**，不得 fall through。
- **S4 改綁前置**：回合進行中拒絕；目前 worktree 髒或 HEAD 非預期分支拒絕。檢查用新的**非破壞性**
  `inspectWorktree()`——`removeWorktreeIfClean()` 判定乾淨時會直接刪除，不能當前置檢查。
- **S5 autocomplete 過授權閘**，且必須用 `interaction.respond([])`（autocomplete 不可 `reply()`）。
- **S6 clone fail-closed**：僅 `https`/`ssh`；拒 `ext::`（**真 RCE**：git `protocol.ext.allow` 預設
  `user`）、`file:`、`http:`、`-` 開頭、控制字元、內嵌憑證、internal/loopback/metadata host；
  argv 陣列啟動；隔離 ambient git/ssh 設定（`url.*.insteadOf`、`ProxyCommand`）。

### 12.4 否決的方案與理由
| 方案 | 否決理由 |
|---|---|
| `REPOS_ROOT` 與 `CONTROLLED_REPO_PATH` 並存 | 兩條安全邊界；`bindingOk` 複雜化；鍵名長期說謊 |
| `DEFAULT_DEV_MODE` / `/new dev:` | 抵觸「local 需明確 opt-in」，只是把同一個風險延後 |
| 扁平 worktree 佈局 `<root>/<threadId>` | `addWorktree` 會重用既有目錄 → 改綁 A→B 後「記錄寫 B、實際在 A 工作」。改為 `<repoHash>/<threadId>`；舊記錄沿用其路徑，不遷移 |
| 「`REPOS_ROOT` 不得位於任何 git worktree 內」 | 過嚴且多餘。實測：內層有自己 `.git` 的 repo，`--show-toplevel` 回自己，外層不會贏；真正的危害（無 `.git` 的候選解析到外層）已由 binding gate 擋下。這條會誤擋「家目錄是 dotfiles repo」這個很常見的配置 |
| 「任意公開主機」clone policy | 主機名稱無法證明 DNS 指向何處；DNS rebinding／重導向擋不住 |
| 擴充 `Transport` 介面來發確認卡 | 那個 seam 是 **agent 觸發**的 UI；加方法會逼每個測試 fake 長出沒有 agent 會用到的東西。改用 `session.broker` + app 直接發按鈕 |
| 「未綁定 session」狀態（`DEFAULT_REPO` 留空時） | 會多一個生命週期狀態要 reconcile，且確認機制依賴 `session.broker`。改為 `/new` 在**建立 thread 之前**就拒絕 |

### 12.5 已接受的殘留風險
- **S3 租約是行程內的**。`instanceId()` 允許同機多實例，各有自己的鎖檔；兩個實例共用同一個
  `REPOS_ROOT` 時租約互不可見。**刻意不做跨行程 lock file**：`single-instance.ts` 已有 PID 鎖原語，
  但推廣成「每個 canonical repo 一個租約檔」需處理 stale 偵測、crash 回收與跨平台語意，而觸發條件是
  操作者刻意跑兩個共用 `REPOS_ROOT` 的實例——與既有的多主機限制同層級。README／DISCORD-SETUP
  必須明說「同一行程內」（已加註）。
- **TOCTOU**：SDK 的 `workingDirectory` 是字串；`realpath` 只能擋**靜態**的 junction／短檔名別名，
  擋不掉建立 session 前一刻的目錄替換。`validateBinding` 已在 `/new`、rebind、resume 建立 actor
  之前執行，但那仍是「檢查後使用」，不是原子操作。
- **`/repo clone` 走 `gh` 時使用操作者已登入的 GitHub 憑證**，因此能 clone 私有 repo。與本工具
  「以 OS 使用者身分執行、用已登入的 Copilot」的既有姿態一致，屬刻意決定。
- **`allowlist` 仍無法防 DNS 解析到內網**（見 12.4 最後一列）。預設 `github` 不受影響。

### 12.6 新增的測試對照
| 不變式 | 測試 |
|---|---|
| S1 | `binding.test.ts`（真 git worktree，含「repo A 的 worktree 冒充 repo B」） |
| S2 | `repo.test.ts`（雙向、`Repos-evil`、junction、Linux 大小寫、`C:foo`） |
| S3 | `app-reconcile.test.ts`（`local-conflict` 阻擋 + 兩個 worktree 可共用 repo）、`app-rebind.test.ts`（租約轉移、離開 local 時釋放） |
| 改綁交易性 | `app-rebind.test.ts`（前置條件、建立失敗完整回滾、並行改綁被拒、teardown 未確認時保留舊 worktree） |
| S6 | `repo-provision.test.ts`（`ext::`、`file:`、`http:`、`-` 開頭、`169.254.169.254`、`localhost.`、`::ffff:127.0.0.1`、Windows 保留字） |
| schema v3 遷移 | `session-store.test.ts`（三條規則 + 不再展開未驗證欄位） |
| 安裝器契約（極性反轉） | `setup-core.test.ts`、`setup-integration.test.ts`、`config-contract.test.ts` |

## 13. 多頻道存取與 ChannelRegistry（後補決策紀錄）

### 13.1 接受的設計與不變式

這項變更刻意把「指令看得到」和「bot 會不會動作」拆成兩個平面：

1. **Discord Integrations 平面**由伺服器管理員手動設定 command visibility；它決定 `/`
   選單是否顯示指令，但不是本 bot 的安全邊界。Discord 依使用者的
   `USE_APPLICATION_COMMANDS`／Application Command Permissions v2 決定可見性，而非 bot 的
   `VIEW_CHANNEL`：<https://docs.discord.com/developers/interactions/application-commands#application-command-permissions-object-using-default-permissions>。
   Bot token 不能改 command-permissions；該 endpoint 要有人類 OAuth2 bearer token 的
   `applications.commands.permissions.update`：<https://docs.discord.com/developers/interactions/application-commands#permissions>。
   因此 command visibility 必須由管理員維護，且與 bot 重啟時的 guild-command bulk overwrite
   分開：<https://docs.discord.com/developers/interactions/application-commands#bulk-overwrite-guild-application-commands-json-params>。
2. **Bot ChannelRegistry 平面**才是執行授權。除 `/channel` 外，`isAuthorized` 必須同時驗證
   allow-listed user、設定的 guild，以及目前頻道本身或其直屬 thread parent 在 enabled set。
   enabled set 是永遠存在的 `DISCORD_PARENT_CHANNEL_ID` seed 加上持久化
   `~/.discord-copilot-sdk/<instance>.channels.json` 的 `/channel enable` 項目。Discord 仍會把
   interaction 送到 bot，且 initial response 不需要 `SEND_MESSAGES`：
   <https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction>；
   所以所有未通過 bot 平面的請求都要 fail-closed，ephemeral 拒絕且不做任何工作
   （callback 規則：<https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback>）。

ChannelRegistry 的檔案存在卻無法讀取、不是合法 schema、版本不相容或 guild 不同時，啟動必須
**拒絕**。把它靜默當成「只剩 seed」會在 reconcile 時把其他已啟用頻道的 records 標成
`blocked`；`blocked` 是終態，之後重新啟用也不能復原對話。少一次啟動可恢復，錯誤地封鎖
對話不可恢復。

`/channel` 是唯一採 `isOwner` 而非 `isAuthorized` 的命令：它仍要求 allow-listed user 與設定
guild，但刻意不要求目前位置已 enabled，否則無法從未啟用頻道 bootstrap。這也明確信任
`DISCORD_ALLOWED_USER_IDS` 中每一位使用者都是頻道管理者；不得把此 location-independent
gate 擴大到 button、autocomplete 或其他命令。

`/new` 在建立 thread 前、以及建立 worktree 和 binding proof 後、寫入 record 前，重查其
**目標 parent 是否仍 enabled**。這防止 `/channel disable` 穿插於多個 await 間，讓已撤銷的
頻道取得 session，並在下一次啟動才被不可逆地標為 `blocked`。這裡刻意**不用**全域
ChannelRegistry epoch：其他頻道的 enable／disable 不得誤中止本頻道合法的 `/new`。

每個 `SessionRecord` 都保存其**精確** `parentChannelId`。resume 與 rebind 必須以該 record
欄位比對 thread 的真實 parent，而不是拿目前 seed、或「任一 enabled channel」代替；rebind
保留這個 per-record parent binding。這修正 record 聲稱在 A、實際 thread 卻在 B 時仍可
resume 的錯誤。

### 13.2 否決方案與已接受風險

| 方案／風險 | 決定與理由 |
|---|---|
| bot token 自行用 OAuth2 改 command permissions | **否決**：bot token 沒有該 endpoint 所需的人類 OAuth2 bearer 權限；見 <https://docs.discord.com/developers/interactions/application-commands#permissions>。 |
| 以 `VIEW_CHANNEL` 或可見頻道自動偵測授權 | **否決**：它不控制 slash-command visibility，也不阻止 interaction delivery；會把 Discord UI 設定誤當安全邊界。 |
| 多 guild registry | **否決（v1）**：設定與 registry 都只屬一個 guild；跨 guild 的 registry 視為不可信並拒絕啟動。 |
| Discord Integrations 設定需人工維護 | **接受**：管理員必須自行 deny-all 再 allow 工作頻道；bot 只保證自己的授權平面，不能替代平台可見性設定。 |
| allow-list 使用者可啟用公開頻道 | **接受**：`isOwner` 使每個 allow-listed user 都能把 agent 輸出導向公開頻道；v1 是單一 owner lab 工具，靠 allow-list 的信任邊界與操作紀律。 |
| `blocked` 為終態 | **接受**：為避免誤把舊 conversation 接到新授權位置，重新啟用頻道不復活 record；以 `/end` 清理後才可 `/new`。 |

### 13.3 §9.1 涵蓋補充（已實作）

| 測試檔 | 不變式 |
|---|---|
| `test/channel-registry.test.ts` | 缺檔以外的 read/parse/schema/version/guild 錯誤拒絕啟動；seed 永遠 enabled；成功 enable/disable 先持久化再變更記憶體，並遞增 epoch。 |
| `test/discord-routing.test.ts` | 非 `/channel` 需要 user + guild + enabled channel／直屬 thread；`/channel` 的 `isOwner` 僅略過位置 gate，不能授權 button 或 autocomplete。 |
| `test/app-channels.test.ts` / `test/app-channels-race.test.ts` | `/channel` 的 seed／權限／持久化失敗行為；`/new` 在目標頻道被 disable 時回復 thread/worktree 且不留 session，其他頻道變動不誤中止；disable 有 live 或 `active`/`creating` record 時拒絕。 |
| `test/app-reconcile.test.ts` / `test/app-rebind.test.ts` | 每筆 record 的實際 thread parent 必須精確等於 `parentChannelId`；不是「任一 enabled parent」即可 resume，rebind 也保留該 binding；`config-mismatch` 不能靜默遺失 fallback 通知。 |
| `test/transport.test.ts` | `noticeDelivered()` 對不存在或無法傳送的頻道回傳 `false`，讓 caller 能改投 seed。 |
| `test/shipped-scripts.test.ts` | 英／繁中 twin 皆含安全安裝命令，並驗證 language switcher 與本地 Markdown 連結。 |

## 14. 更新與發版機制（2026-08-06）

### 14.1 決策

- 採用本機 `update.ps1`／`update.sh` 加 `scripts/update.mjs` 的三階段流程：**唯讀 preflight → apply → 僅成功後 restore**。更新器在停止前檢查 origin、remote ref、checkout 形狀、多 instance、FF-only 可行性、新版設定與 active thread/worktree。
- 網路一行形式不直接 fetch/checkout 目標；它下載最新 engine 到私有暫存目錄，讓 engine 先停常駐與 bot 再變更 source。這保留自救能力，也避免 Windows npm 覆寫 live runtime 的 EPERM。
- dev branch 僅允許乾淨且 `merge-base --is-ancestor` 可證明的 `git merge --ff-only`；managed detached clone 用 depth-one fetch 加 `checkout --detach FETCH_HEAD`。
- 不做 Discord `/update`：行程不能安全覆寫自己的 runtime，失敗後 Discord 也無法回報；這是 fail-closed 取捨，不是 UX 缺漏。
- 初始版本為 SemVer `0.1.0`，`--version` 顯示 app 版號、commit 與 SDK。發版分成「規劃」與「發布」兩步：先跑 `node scripts/release.mjs --plan` 取得 version 提案、`CHANGELOG DRAFT` 與 `REVIEW BY HAND`，但那只是證據；必須由人確認版本與整理過的英文 notes，先合併進 `## [Unreleased]` 並 commit，之後才可在乾淨 tree 執行 `npm run release -- <version>` 建立 release commit 與 annotated tag。真正發布只靠 `git push --follow-tags` 觸發 workflow；workflow 先用 `node scripts/release.mjs --notes <version>` 讀取最終 `CHANGELOG.md` 區段當 release body，再附 GitHub 自動產生的 notes，不手動 `gh release create`。
- 發版版本規則固定為：在 `0.x` 期間，breaking 變更升 **minor**、`feat` 升 **patch**、`fix` / `perf` / security fix（含 `fix(security)` 與 subject 含 `CVE`）都升 **patch**；`>=1.0.0` 後才改成 breaking 升 **major**、`feat` 升 **minor**、`fix` / `perf` / security fix 升 **patch**。若沒有任何 release-worthy commit，就不發版、不硬湊版本號。`REVIEW BY HAND` 會自動攔下非 conventional 與非 ASCII 主旨；任何不明確是英文的文字都必須先由人重寫或翻譯，才能進 CHANGELOG。
- `scripts/update.mjs` 對 release ref 的相容性是刻意設計：`remoteRefSpecs()` 對 `refs/tags/vX.Y.Z` 會同時展開 `refs/tags/vX.Y.Z` 與 `refs/tags/vX.Y.Z^{}`，`resolveRemoteSha()` 會偏好 peeled `^{}` commit，再由 `fetchResolved()` 在實際 fetch 前去掉 `^{}`。這是為了讓 `npm run update -- --ref refs/tags/vX.Y.Z` 同時相容 annotated 與 lightweight tags，而 `--check` 比較的也是最終 checkout 會落到的 commit。

### 14.2 殘留風險

- source 移動後的完整 runtime/schema 驗證必須先 build，而 Windows build 不能與 live runtime 共存；故預檢覆蓋新版 `validate.mjs`，但 setup 在 apply 後失敗時**不**自動 restore。operator 修正後必須明確 `--restore`。
- Windows 用硬終止停止 bot，in-flight turn 可能遺失；active-thread guard 只報告可 resume 的 thread 與髒 worktree，不能誠實地宣稱知道記憶體中的 turn 是否正在執行。

## 15. 平台路徑 test 字面量稽核（2026-08-07）

### 15.1 觸發原因

原 `test/version.test.ts` 把 Windows 字面量 `"C:\\repo\\package.json"` 當作
`path.join(root, "package.json")` 的 expected value，在 Ubuntu CI 上
`path.posix.join("C:\\repo", "package.json")` 會回 `"C:\\repo/package.json"`
（正斜線），等式因此失敗。父任務已把 expected 也改成透過 `path.join` 推出，
本節記錄跨全部 test 檔的完整稽核，確認沒有其他同類 bug。

### 15.2 稽核結果

* 掃描目標：`test/*.ts` 內所有 `C:\\`（等同來源中 `C:\`）字面量。
* 統計口徑改正：這裡記的是 **source literal occurrences**，不是 matching
  lines。以 Python 對原始檔文字重算後，結果是 **12 個 test 檔、67 個
  字面量**。細分：`version.test.ts` 11、`session-actor.test.ts` 13、
  `session-store.test.ts` 11、`app-stop-flow.test.ts` 4、
  `config-contract.test.ts` 4、`config.test.ts` 1、`env-file.test.ts` 6、
  `repo.test.ts` 5、`residency-powershell.test.ts` 2、`residency.test.ts` 4、
  `uninstall-core.test.ts` 5、`worktree.test.ts` 1。
* 分類（每個字面量都逐一檢視，非只看檔名）：
  * **(a) 純字面量 / 身份鍵**（62 個）：值以字串型式被存、序列化、
    或做字典鍵查找。實際生產程式碼不會用 `path.join` / `path.resolve` /
    `path.normalize` / `path.relative` 對它做跨平台比較。
    * `version.test.ts` 全部 11：`readAppVersion` / `readCommitSha` 的
      `repoRoot` 參數，經注入的 `readFile` / `runGit` 直接回顯。
      `readAppVersion` 內部確實用 `path.join(repoRoot, "package.json")`
      建構檔名，但 test 已把 expected 值同樣經 `path.join` 推導，兩邊在
      任何平台都會匹配。
    * `session-actor.test.ts` 13：其中 12 個是
      `SessionActor.workingDirectory` / `approvalKey`，傳入後被存回 SDK
      config 或作為 `ApprovalPolicy` 的 dict key（原碼
      `src/core/approval-policy.ts:32,39,89` 直接字典查詢，**絕不** 對 key
      做 `path.resolve`）。剩下
      `fileName: "C:\\repo\\secrets.txt"` 是 permission-request /
      audit-notice view fixture：測試只驗證 notice 會揭露 `secrets.txt`
      檔名、但不回顯 secret payload；它不是 runtime working-directory /
      approval-key fixture，也不會被 path API 正規化或 join。
    * `session-store.test.ts` 11：JSON record 的 `repoPath` / `workDir`
      欄位，`src/core/session-store.ts:174,177,348,374` 全部原樣寫入、
      原樣讀出。v1→v2 migration 也 pass-through。
    * `app-stop-flow.test.ts` 4：fake `cfg.REPOS_ROOT` 與
      `DiscordCopilotApp.createForTest` 第二參數 + `Session.workDir` /
      `Session.repoPath` fixture — 這個測試路徑 (`/stop` 與圖片下載)
      根本沒有 join 這些值。
    * `config-contract.test.ts` / `config.test.ts` 5：zod schema 輸入值，
      schema 本身無 I/O、無 path 運算（`src/config.ts:63-93`）。
    * `env-file.test.ts` 6：`.env` 序列化 / 解析 round trip fixture，
      是位元組層 API，與 OS 無關。
    * `residency.test.ts` 4：`buildWindowsRegisterScript` 純字串
      builder 的 fixture，輸出以 substring / equality 對照。
    * `uninstall-core.test.ts` 5：`isOurBotCommandLine` /
      `isOurTaskDefinition` 的字串 / 正則 matcher fixture — 用真實
      Windows tasklist / schtasks 會產生的字串當輸入。
    * `worktree.test.ts` 1：註解裡的反例，並非執行碼。
    * `repo.test.ts` 1：拒絕清單裡的 `"C:\\Windows"` 是平台無關的拒絕輸入。
    * `residency-powershell.test.ts` 1：BOM regression test 內
      `"C:\\Users\\使用者測試"` 是 `.ps1` script-body fixture，測的是
      BOM/編碼與 parse 行為，不是 runtime 路徑等式。
  * **(b) 平台守衛**（5 個）：字面量在 `process.platform === "win32"`
    或等價的 skip / fallback 保護內。
    * `repo.test.ts` 4：`existsSync("C:\\PROGRA~1")` 與
      `canonicalPath("C:\\PROGRA~1")` 三處都在
      `if (process.platform !== "win32" || !existsSync(...)) return;` 之後。
    * `residency-powershell.test.ts` 1：`SystemRoot` fallback 的
      `"C:\\Windows"` 只供 `describe.runIf(isWindows)` 這組 Windows-only
      測試定位 `powershell.exe`。
  * **(c) 需要平台原生 path 運算**：**0 個**。
  * **(d) 真正的 bug**：**0 個**（父任務已修好原本那 1 個）。
* 逐一檢視後，**0 個**剩餘字面量會流入 runtime path 輸出等式斷言；
  本次因此只需更正文檔與稽核報告，不需要再改 feature code / tests。

### 15.3 操作規則（regression 防護）

**永遠不要** 把寫死的 Windows 路徑字面量拿去跟 runtime `path.join` /
`path.resolve` / `path.normalize` / `path.relative` 的輸出做等式比較。
需要 expected value 時，用**同一個 platform `path` 模組**推導。Windows
路徑字面量仍可保留、也**必須**保留在下列用途：純字串 fixture、序列化
round trip、字典鍵、拒絕清單、`process.platform === "win32"` 之後的分支。
本 repo 有意保留這些 fixture，一次全面禁絕 `C:\\` 字面量會把 env-file
round-trip、residency 腳本、uninstaller matcher 這些真正需要 Windows
輸入的測試都無謂地誤傷。

### 15.4 為何刻意不新增 blanket 掃描 test

觸發 CI 失敗的 error class 需要兩個事實同時成立（寫死 Windows 字面量
**且** 等式另一側是 runtime `path.join`），純靜態 grep 無法把兩件事關聯
起來而不誤傷像 `readCommitSha` 那樣讓字面量流過 `["-C", literal, ...]`
再對同一個字面量斷言的合法場景。真正的 anti-regression 是 `version.test.ts`
把 expected 改用 `path.join(repoRoot, "package.json")` 推導 — 未來若
`readAppVersion` 又退回硬編字面量，這個斷言會在 Ubuntu CI 立刻紅。

### 15.5 驗證

```
npm run typecheck
npx vitest run test/version.test.ts test/session-actor.test.ts \
  test/session-store.test.ts test/app-stop-flow.test.ts \
  test/config-contract.test.ts test/config.test.ts \
  test/env-file.test.ts test/repo.test.ts test/residency.test.ts \
  test/uninstall-core.test.ts test/worktree.test.ts
# Test Files  11 passed (11)
# Tests       250 passed (250)
```

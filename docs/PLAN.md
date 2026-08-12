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
鍵：`turnId/messageId/toolCallId/agentId`。累積 delta；**持久化 `assistant.message` 為權威最終**（不重複貼）；**過濾 agentId** 只呈現主回應；尾端訊息約 750–1000ms 編輯一次 + turn 末 flush；區塊約 1900 字、凍結；佇列有界（丟中間、保最終）；rate limit 交給 discord.js bucket；以**依到達順序 timeline** 呈現文字／工具／系統狀態：工具為一行 dimmed subtext，thinking 以 Discord spoiler 預設收合、可點擊展開；新 session 明確請求 `reasoningSummary:"detailed"`，`/model` 切換也重送該要求；明確 `streaming:true`。

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
| **空 tool-only message 不產生空行** | `turn-render.test.ts`（`does not create blank timeline items...`；3 個空 message 的 8 換行回歸）|
| **文字／工具／thinking 真實時序** | `turn-render.test.ts`（`keeps text, a tool, and post-tool text in arrival order`）、`transport.test.ts`（timeline transport render）|
| reasoning / intent 顯示 | `normalize.test.ts`（SDK data shape）、`session-actor.test.ts`（`renders SDK intent and reasoning events...`）、`format-timeline.test.ts` |
| Discord table 降級 / CJK 對齊 | `format-timeline.test.ts` |
| spoiler / code-fence 邊界 | `format-timeline.test.ts`、`timeline-chunk.test.ts` |
| 卡片跨界工具身分 | `session-actor.test.ts`（`preserves a tool's identity...`）|
| YOLO durable audit | `audit-log.test.ts`、`session-actor.test.ts`（persist-before-approve / log failure deny）|
| sub-agent 不交錯 | `turn-render.test.ts`（`ignores any sub-agent` / `does not let a sub-agent ... overwrite`）|
| 未知權限變體 fail-closed | `session-actor.test.ts`（`auto-denies a non-shell permission (fail closed)`）|
| resume 對帳四種情形 | `reconcile.test.ts`（14）+ `app-reconcile.test.ts`（9）|
| **message 404 新 anchor** | `render-chunks.ts` + `render-chunks.test.ts`（`RE-ANCHORS ...`、survivor-safety；補貼於尾端，見下方殘留）|
| **rebind 舊 incarnation teardown / `/end` 交錯** | `app-rebind.test.ts`（post-swap 舊 actor retain/retry、`/end` 同時擁有 replacement + 舊 worktree、unconfirmed durable pointer、pre-swap rollback end race）+ `session-store.test.ts`（v5 stale-rebind terminal record restart persistence）|
| 最小 CI（Win/Ubuntu、Node 20.19+22.12）| `.github/workflows/ci.yml` |

**設計決策（與 §9 措辭的差異，刻意記錄）：**
- **「modal 路徑」= thread 訊息自由輸入**，非 Discord modal 彈窗。行動裝置友善、無彈窗限制；freeform 能力已實作並測試（`session-actor.test.ts` `freeform message answers (wasFreeform=true)`）。不另做 Discord modal（YAGNI，非使用者需求）。
- **Restart smoke（P2）** 的自動化部分即 `app-reconcile.test.ts`（9 個 app 層 resume 對帳情形，以 fake 驅動）+ `reconcile.test.ts`；真正的「重啟後 live 復原」已於開發時人工驗證（斷線→重啟→喚回暗號 PELICAN-77）。可跑於 CI 的 live-restart 需真實 Discord+Copilot，超出無網路 CI 範圍。
- **安裝器測試框架**（`secure-file`/`setup-core`/`setup-integration`）屬 **P6 安裝器回歸**，另立 issue 追蹤，不計入本 §9（#8）。
- **thinking 預設收合而非預設關閉**：使用者需要能回看 CLI 風格的判斷過程；Discord 沒有 accordion，故以 spoiler 做唯一原生的點擊展開。新 session 與 `/model` 切換明確請求 `reasoningSummary:"detailed"`。原始 reasoning 中的 ````` fence 與 `||` 會被轉為純文字，且限制 1200 字，避免 Discord code block 取消 spoiler 與跨訊息拆分的未定義行為。Runtime 沒有 reasoning 時顯示 `assistant.intent` 作短摘要。已測 runtime 的 Claude summary 可能是 opaque、無可顯示內容；GPT reasoning 模型可提供可顯示 summary，因此 UI 以 provider 實際事件為準。
- **YOLO 稽核耐久性先於排版**：每個自動核准先同步 append + fsync `~/.discord-copilot-sdk/<instance>.audit.jsonl`，寫入失敗即拒絕；Discord timeline 行可以是 best-effort，卻不再是唯一稽核紀錄。相同 raw entry 才能折疊計數，避免被截斷的不同指令誤合併。
- **時間軸不是不可偽造的安全 UI**：agent 仍可能在普通文字中仿造 `-#`／emoji。它不會改變 permission card 的 fail-closed 閘或 JSONL 稽核，但操作者不可把視覺樣式當成授權證據。

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
- 更新輸出採分階段身分／生命週期報告：在遠端比較前印出 source SemVer、SHA、絕對 root 與 checkout，解析成功後印出 requested/ref resolved SHA；成功 apply 依序報告 stop、source、setup、restore。只有 `liveInstances()` 觀察到新 PID 才宣稱重啟成功；更新前已停止的 instance 維持停止並明講。`--check` 的 `0` 僅代表 HEAD 等於要求 ref，絕不是 runtime 健康結論；若有待 `--restore` 狀態，即使 source 相同也必須警告。
- entrypoint 與 engine 都以字面的 `git config --get remote.origin.url` 驗證 upstream，不能使用會展開 `insteadOf` 的 `git remote get-url`，以免企業 mirror 使一行命令靜默 fallback 到另一個 checkout。`--restore` 比對 state 記錄的絕對 `repoRoot`：foreign state 絕不會被執行（只警告並保留），同 root state 照常恢復；若完全沒有相符 state 則 fail-closed。若 foreign state 與 apply 使用相同 instance id，apply 也會在任何停機或寫入前拒絕，絕不能覆寫另一個 checkout 的唯一恢復紀錄。
- dev branch 僅允許乾淨且 `merge-base --is-ancestor` 可證明的 `git merge --ff-only`；managed detached clone 用 depth-one fetch 加 `checkout --detach FETCH_HEAD`。
- 不做 Discord `/update`：行程不能安全覆寫自己的 runtime，失敗後 Discord 也無法回報；這是 fail-closed 取捨，不是 UX 缺漏。
- 初始版本為 SemVer `0.1.0`，`--version` 顯示 app 版號、commit 與 SDK。發版分成「規劃」與「發布」兩步：先跑 `node scripts/release.mjs --plan` 取得 version 提案、`CHANGELOG DRAFT` 與 `REVIEW BY HAND`，但那只是證據；必須由人確認版本與整理過的英文 notes，先合併進 `## [Unreleased]` 並 commit，之後才可在乾淨 tree 執行 `npm run release -- <version>` 建立 release commit 與 annotated tag。真正發布只靠 `git push --follow-tags` 觸發 workflow；workflow 先用 `node scripts/release.mjs --notes <version>` 讀取最終 `CHANGELOG.md` 區段當 release body，再附 GitHub 自動產生的 notes，不手動 `gh release create`。
- 發版版本規則固定為：在 `0.x` 期間，breaking 變更升 **minor**、`feat` 升 **patch**、`fix` / `perf` / security fix（含 `fix(security)` 與 subject 含 `CVE`）都升 **patch**；`>=1.0.0` 後才改成 breaking 升 **major**、`feat` 升 **minor**、`fix` / `perf` / security fix 升 **patch**。若沒有任何 release-worthy commit，就不發版、不硬湊版本號。`REVIEW BY HAND` 會自動攔下非 conventional 與非 ASCII 主旨；任何不明確是英文的文字都必須先由人重寫或翻譯，才能進 CHANGELOG。
- `scripts/update.mjs` 對 release ref 的相容性是刻意設計：`remoteRefSpecs()` 對 `refs/tags/vX.Y.Z` 會同時展開 `refs/tags/vX.Y.Z` 與 `refs/tags/vX.Y.Z^{}`，`resolveRemoteSha()` 會偏好 peeled `^{}` commit，再由 `fetchResolved()` 在實際 fetch 前去掉 `^{}`。這是為了讓 `npm run update -- --ref refs/tags/vX.Y.Z` 同時相容 annotated 與 lightweight tags，而 `--check` 比較的也是最終 checkout 會落到的 commit。

### 14.2 殘留風險

- source 移動後的完整 runtime/schema 驗證必須先 build，而 Windows build 不能與 live runtime 共存；故預檢覆蓋新版 `validate.mjs`，但 setup 在 apply 後失敗時**不**自動 restore。operator 修正後必須明確 `--restore`。
- Windows 用硬終止停止 bot，in-flight turn 可能遺失；active-thread guard 只報告可 resume 的 thread 與髒 worktree，不能誠實地宣稱知道記憶體中的 turn 是否正在執行。
- updater 故意還原更新前的狀態，而不是無條件啟動：原先被刻意停掉的 instance 不會在 update 後自行運行。需要強制啟動時 operator 依 updater 印出的 instance 專屬命令執行。

### 14.3 Detached startup readiness（2026-08-09）

- app PID lock 仍是唯一的 instance ownership 真相，且在載入 Discord／SDK runtime 前由 entry bootstrap 取得；這縮短 stale lock 被回收後到新 owner 可見之間的視窗，使 `stop-bot` 能在 startup 中辨識並停止正確的 PID。
- `run-bot.ps1`／`run-bot.sh` 共同呼叫 `scripts/run.mjs`，不再把「child 活過兩秒」當成成功。launcher 產生一次性 256-bit token，只有 `DiscordCopilotApp.start()` 完成 Copilot、gateway、commands、reconcile 與 staging cleanup 後才原子寫入 token 對應 marker。
- launcher 僅在 **child PID = live app lock owner = marker PID/instance** 時宣告 ready。token marker 是一次性的完成證明；成功、child failure、timeout 與 launcher 中斷都清除它。app 也寫入 per-instance current-ready marker，供 updater 驗證常駐服務恢復；它同樣必須吻合 live lock PID，graceful shutdown owner-aware 清除，故不是第二份 PID registry。
- ready 最多等待 120 秒。逾時或 marker 不可信時只終止 launcher 自己建立的 child PID，絕不依名稱掃描或終止其他 Node process。Windows hard-stop 仍可能留下 stale app lock，下一次 app 以既有 owner-aware reclaim 回收。

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

* §15.2 的人工稽核範圍是 **12 個 test 檔 / 67 個字面量**；下面這條
  `vitest` 指令則是刻意縮成 **11 個檔 / 252 個 tests** 的 targeted rerun，
  只重跑會在跨平台 CI 上直接驗證本次風險模型的那批 suite。
* 被刻意省略的第 12 個檔是 `test/residency-powershell.test.ts`。它已在
  §15.2 被逐字面量人工稽核，且其 Windows-only 行為先前已由完整 Windows
  suite 覆蓋；本節因此不把它再塞進這條 targeted command，但 **67 / 62+5**
  的稽核統計與 **252** 的 rerun 計數都維持不變。

```
Set-Location C:\Source\Repos\discord-copilot-sdk-update-mechanism
npx vitest run test/version.test.ts test/session-actor.test.ts \
  test/session-store.test.ts test/app-stop-flow.test.ts \
  test/config-contract.test.ts test/config.test.ts \
  test/env-file.test.ts test/repo.test.ts test/residency.test.ts \
  test/uninstall-core.test.ts test/worktree.test.ts
# Test Files  11 passed (11)
# Tests       252 passed (252)
```

## 16. PR #14 提前合併事故紀錄（2026-08-07）

### 16.1 已確認時間線

- PR #14 的 PR-side workflow run **31143831917** 於 **2026-08-07 03:16:10 UTC**
  建立；第一批 jobs 於 **03:16:14 UTC** 開始。
- PR #14 於 **03:16:27 UTC** merged；當時其 PR-side run **31143831917** 只跑了
  **13 秒**（jobs 自 **03:16:14 UTC** 起算），四個 test matrix jobs 都還在
  running。
- merge commit **`7281e3a`** 於 **03:16:29** 到達 `main`。PR #14 原 CI 的四個
  test jobs 隨後在 **03:16:51、03:16:55、03:17:36、03:17:38** 失敗。
- merge commit 對應的 `main` CI run **31143847250** 也是失敗：四個 test jobs 全紅，
  只有 `lint shell + installer scripts` success。
- 修復 PR #15 於 **03:26:33** merge，commit **`c336672`**；其 `main` CI run
  **31144359846** 五個 jobs 全部 success。

### 16.2 根因與修復

1. `test/version.test.ts` 把 Windows 字面量 `C:\\repo\\package.json` 拿去比對
   runtime `path.join` 輸出；Ubuntu 使用 slash semantics，導致 expected value
   錯誤。修復是讓 expected path 也用同一個 `path.join` 推導。
2. `release-workflow.test.ts` 的 multiline regex 只接受 LF；Windows checkout
   workflow YAML 時因 `.gitattributes` 沒有 `*.yml` 規則而得到 CRLF。修復分兩層：
   根因修正是 pin `*.yml text eol=lf`，讀檔端再做 CRLF 正規化作 defense in
   depth。

### 16.3 操作規則

- 2026-08-09 起，maintainer 有意永久移除 `main` 的 branch protection，讓 release
  可以依既定流程直接以 `git push --atomic --follow-tags origin main` 推送 release
  commit 與 annotated tag。原本的 `strict=true`、`enforce_admins=true`、PR gate 與
  五個 required contexts 均已不再是 GitHub 強制控制。
- **接受的殘餘風險**：PR #14 的 merge-before-CI 事故證明 branch protection 是當時唯一
  的系統性防線；移除後，`main` 可在 CI 尚未完成或已失敗時前進。`ci.yml` 仍會在
  `push: branches: [main]` 和 PR 觸發，但只屬事後偵測，不能阻擋推送或 tag-driven
  Release。
- 取代控制是操作紀律，不得被誤稱為 enforcement：任何推送前必須在本機完成
  `npm run typecheck` 與 `npm test`；推送後必須用 `gh run view <id> --json jobs`
  確認 `test (ubuntu-latest, node 20.19)`、`test (ubuntu-latest, node 22.12)`、
  `test (windows-latest, node 20.19)`、`test (windows-latest, node 22.12)`、
  `lint shell + installer scripts` 五個 job 的 `conclusion=success`。
- 完成報告必須明確區分 **local validation** 與 **GitHub Actions CI**，並揭露中間
  是否曾有失敗 run；不得只回報最後一次成功。

### 16.4 更正動作的邊界

- 這次歷史失敗 run 不能被抹除，也不應 revert `7281e3a` 來重寫歷史；`c336672`
  已修正缺陷。矯正措施是補文件、收斂合併規則、預防再發，而不是試圖消去既有
  失敗紀錄。

## 17. Explicit repo/user skills，不開 broad discovery（2026-08-11）

### 17.1 觸發與可重現根因

Discord thread 顯示 `🔧 skill — failed`。這不是 renderer 誤報；真實 runtime 回傳
`success:false`、`error.message = "Skill not found: brainstorming"`。

對本機 CLI `1.0.71` 與 SDK `1.0.7-preview.3` 的 bundle / runtime probe 證實：

1. CLI 註冊 skill tool 的 `Qvt(...)` 呼叫點只傳 `enableConfigDiscovery`，**沒有**
   傳 `enableSkills`；因此 `XT()` 內 `enableSkills:false` 的 skills-empty short circuit
   永遠不會走到。
2. builtin skill root 不受 `enableConfigDiscovery:false` 影響；skill tool 仍會送給 model，
   但未配置 roots 時清單只剩 builtin `customize-cloud-agent`。
3. tool description 又明說「使用者明確點名但未列出的 skill 仍要 invoke」，所以 model
   會產生必然失敗的 `Skill not found` call。

因此 `enableSkills:false` **不能**當作 v1.0.71 的 skill-tool 安全控制。空來源時只能再加
`excludedTools:["skill"]`；live probe 已驗證這會從真實 CLI catalog 移除 skill tool，
且 shell/glob 不受影響。

### 17.2 採納的設計

使用者選定 repo + user skills 預設啟用，且 project roots 跟隨 CLI 原生慣例：

| 根 | 預設 | 開關 |
| --- | --- | --- |
| `<workingDirectory>/.github/skills`、`.agents/skills`、`.claude/skills` | on | `ENABLE_REPO_SKILLS` |
| `~/.copilot/skills` | on | `ENABLE_USER_SKILLS` |

`core/skills.ts` 用同步、可測的目錄探測決定是否至少有一個 `SKILL.md`。來源有不同錯誤策略：
user root 探測到 `EACCES` 或暫時 IO 問題時刻意 **fail-open**，避免把使用者的 skills 靜默藏起來；
受控 repo root 在不確定時 **fail-closed**，避免把 inaccessible / 外部 link 路徑交給 CLI。
兩者都只在確定 `ENOENT` / `ENOTDIR` 或確定空目錄時排除。候選 root 本身一律顯式傳給 SDK，
因 live probe 已確認不存在的目錄會被 CLI 安全忽略。受控 repo root（包含 root 本身）的
symbolic link 不跟隨，且 candidate 的 canonical `realpath` 必須仍在 canonical worktree 內，
所以 `.github` / `.agents` / `.claude` 的**父層** junction 也不能逃到外部；user root 會以
`stat` / `realpath` 跟隨有效連結並有 cycle guard，支援 dotfiles 管理的 linked skill。兩個分支
都由真實 CLI probe 驗證。由於 CLI 會跟隨 repo root **內部**的 child link，repo scan 是
all-or-nothing：找到任一 link（即使同 root 另有合法 `SKILL.md`）就拒絕整個 root，避免
`ENABLE_USER_SKILLS=false` 被 repo link 指向 user / 外部 skill 而繞過。

`SessionActor.init()` 是 create 與 resume 共用的唯一組態點；三個 app actor 建立路徑
（`/new`、`/repo` rebind、startup resume）都只把兩個 config switch 傳進去，避免某一路
在 restart 後改變信任邊界。worktree 在 actor 建立前已 checkout，因此已 commit 的 repo
skills 可見；未 commit / untracked skill 只會在 `/repo dev local` 見到。

**禁止**把 `enableConfigDiscovery` 改成 true。SDK 文件明定 broad discovery 同時會找
`.mcp.json` / `.vscode/mcp.json`；對不可信 repo 這等於讓它提供 MCP server 設定。explicit
`skillDirectories` 已在 live probe 證明能載入 repo skill，無須打開那個面。

### 17.3 真實 runtime 證據與保留控制

| Probe | 結果 | 結論 |
| --- | --- | --- |
| `enableSkills:false` vs `true`、discovery off | 都只廣告 1 個 builtin；`brainstorming` failed | 此 CLI 版本忽略該 flag |
| discovery on | repo 13 skills 可呼叫，但 MCP discovery 也開 | 不可採用 |
| explicit repo dirs + discovery off | 13 repo + 1 builtin，`git-commit` success | 採用的窄路徑 |
| explicit user dir + discovery off | 22 user + 1 builtin，`brainstorming` success | user source 可獨立保留 |
| nested repo `SKILL.md` | `skill` invocation success | scanner 的 recursive 探測與 CLI 一致 |
| junctioned user skill directory | `skill` invocation success | user-root link 可以安全支援 |
| `excludedTools:["skill"]` | skill tool definitions = 0；builtin sub-agent 與 resume 亦為 0 | 空來源的正確 fallback |
| 對抗性 repo skill `allowed-tools: Bash` | shell 仍觸發 `onPermissionRequest(kind:"shell")` | SDK headless path 沒有 TUI 的 auto-rule bypass |
| deny variants | runtime 接受 `reject`，拒收 SDK 宣告的互動拒絕 variant | 修正 Deny payload |

`allowed-tools` 的 auto-approval 程式碼存在 CLI interactive TUI 的 React `useEffect`；它不是
SDK session host path。不過這只是**當前版本的實測**，不能當成 sandbox 或永恆的 API 契約。

### 17.4 明確放寬與已接受的殘留風險

這項設計**刻意放寬**「repo 不會影響 agent context」：skill 的 name / description 在 tool
definition 中常駐，即使 skill 未 invoke，也能 prompt-inject model。仍維持的控制：

- `enableFileHooks:false`：repo hook 無法以 `resolvedByHook` 繞過 Discord card。
- `enableConfigDiscovery:false`：repo MCP settings 不會載入。
- `skipCustomInstructions:true`：`AGENTS.md` / `copilot-instructions.md` 仍不載入。
- 所有 shell permissions 仍由 Discord card 決定；tool failure detail 顯示到 Discord 前經
  `sanitizeForInlineCode`，且所有 send path 保留 `allowedMentions:{parse:[]}`。

**YOLO + repo skills 是最高風險組合**：repo skill text 可 steer model，而 YOLO 會移除最後的
Discord permission card。actor 因此追蹤是否真的載入 repo skill，`/yolo mode:on` 的 ack
warning 會額外說明此風險。YOLO 仍是 session-local、volatile，restart/resume 會回到 OFF。

`~/.copilot/skills` 是跨 session 的共享狀態；任何你允許執行 shell 的 session 都可能寫入它，
進而植入另一個 user-skills session。path disjointness 無法解決這件事；接受的緩解只有預設
可關閉、lab-only 機器與文件揭露。

### 17.5 另一個 runtime/SDK 不一致：Deny

SDK `rpc.d.ts` 宣告一個互動拒絕 variant，但真實 local runtime 拒收它：
`permission host returned malformed payload`。過去 Discord Deny 雖仍 fail-closed（指令沒有執行），
卻會向 thread 露出 runtime error。明確 Deny 現改送 `{kind:"reject"}`；timeout/abort/
unsupported kinds 繼續送 `{kind:"user-not-available"}`。`reject` 沒有 `forceReject` 欄位，
不會強殺整個 turn。fake SDK 無法抓這類 schema drift，因此 live smoke 是必要防線。

### 17.6 否決方案

1. **永遠移除 skill tool**：能消除紅字，但使用者明確需要 repo-level skills，故否決。
2. **打開 `enableConfigDiscovery:true`**：會同時載入不可信 repo 的 MCP config，故否決。
3. **接受任意 `SKILL_DIRECTORIES` path**：可指回 controlled repo 或其他不受信任位置，故否決；
   root 是固定的 CLI-native locations。
4. **用 `disabledSkills` 名稱 blocklist**：無法表達「全部移除」，且新 skill 會漏接，故否決。
5. **空來源仍保留 tool**：重現原始必然失敗，故否決。

### 17.7 測試與操作對照

| 風險 / 行為 | 覆蓋 |
| --- | --- |
| roots、空目錄、nested `SKILL.md`、repo/user links、IO fail-open | `test/skills.test.ts` |
| create / resume config、empty ⇒ `excludedTools`、repo-source tracking | `test/session-actor.test.ts` |
| startup resume 真的傳來源開關 | `test/app-reconcile.test.ts` |
| strict switch + blank ⇒ default、installer/runtime parity | `test/config.test.ts`、`test/config-contract.test.ts` |
| installer bilingual keys | `test/i18n.test.ts` |
| error message normalize → render → Discord sanitization | `test/normalize.test.ts`、`test/turn-render.test.ts`、`test/transport.test.ts` |
| YOLO repo-skill warning | `test/discord-routing.test.ts` |
| npm live-smoke command | `test/shipped-scripts.test.ts` |

`npm run smoke:skills` 是**手動** acceptance probe，會在臨時 git repo 以真實登入 runtime 驗證：
explicit repo skill 載入、empty source 真的移除 tool、`allowed-tools` 不繞過 permission host、
`reject` 被 runtime 接受、nested repo / linked user skill 是否可載入，以及 resume 是否套用
explicit skill roots。它不在 CI（需要本機 Copilot 登入），但每次升級 Copilot CLI 必跑。

## 18. 檔案傳送：`/file` + `discord_send_file`（2026-08-12）

### 18.1 採納方案

採用**Windows-only 的雙路徑、同一安全邊界**：

1. Windows 上，使用者明示的 `/file path:<path>`：只允許 session workdir 內、經 canonical path 驗證的檔案，直接送回擁有該 session 的 Discord thread。
2. Windows 上，agent tool `discord_send_file({path,comment?})`：由 host 註冊、repo extension allow-list 控制、每次都要獨立 Allow once / Deny 卡，不提供 session-scope 擴權。
3. Linux、Darwin 與其他非 Windows 平台：session 的建立、resume 與所有非送檔功能照常；但不捕捉 trusted root、不暴露 `discord_send_file`，且 `/file` 明確 fail-closed 回覆平台不可用。

我建議這個方案，因為 SDK 只接受 mutable pathname `workingDirectory`，而非可交給 child/runtime 的 retained fd。Windows root handle 可拒絕 delete/rename，令 pathname 在 create/resume handoff 期間維持綁定；POSIX 則可在 RPC 期間 swap-and-restore，令 RPC 拿到 replacement cwd 而前後檢查都看到原 root。保留 POSIX 送檔會假稱安全，故只保留正常 session，移除這條 outbound capability。

### 18.2 否決方案與取捨

1. **自動送檔、沒有卡片**：優點是 friction 最低；缺點是 agent 只要拿到檔案路徑就能直接把內容送出 Discord，等同新增一條無人工確認的外流通道。與現有 approval model 衝突，故否決。
2. **把 `discord_send_file` 納入 YOLO 自動核准**：優點是行為一致；缺點是 YOLO 本來就已移除最後一道 Discord permission gate，而送檔是額外 outbound exfiltration path，風險明顯更高。故刻意 fast-deny 並提示改用 `/file`。
3. **使用未記錄/未文件化的雲端上傳或暫存轉交**：理論上可繞過部分本機限制，但缺點是平台行為、權限、保留期限與審計語義都不穩定，且會引入第三條未揭露的資料流。因缺乏可驗證契約，故否決。
4. **POSIX retained-fd + SDK 前後 root fence**：優點是 Linux/Darwin 仍可提供送檔；缺點是 SDK API 不接受 fd、也沒有安全的 fd inheritance/cwd handoff。攻擊者可在 create/resume RPC 期間 swap working-directory pathname，並在前後 fence 前 restore，令 SDK 使用 replacement cwd 而兩次檢查皆通過。此基本限制不可由本程式修補，故否決 POSIX 送檔。

### 18.3 安全與競態防護

- **Windows capture-before-binding root capability**：僅 Windows 的 `/new`、rebind、startup resume 都先以 workdir
  捕捉不透明 directory handle；git ownership proof（local 的 `--show-toplevel` 與 worktree 的
  `--git-common-dir`）只接收該 capability 的原始 handle-bound validation path，不能把它
  canonicalise 後改用 mutable final path。Windows 的 directory handle 只分享 read、拒絕 delete/rename，所以其
  handle-derived final path 在 handle 存活時仍綁定同一 root。若 git 不能操作該 validation path
  即拒絕，絕不回退到原 workdir。approval key 也只能在 proof 成功後以該 validation path 的
  `--git-common-dir` 導出，不能先用可替換的 repo pathname 選擇既有授權。proof 完成後同一
  capability 轉交 actor，actor 不得按 mutable pathname 重捕；且在解析 skills/config 前、
  create/resume RPC 前、及 RPC 回傳後都會用**原 handle**重驗 final path + identity。最後一道
  fence 失敗會以 bounded best-effort disconnect/delete 新建 runtime，actor 不會可用或接收 prompt，
  並由既有 init cleanup 恰好 close root 一次。非 Windows 不啟動這套 root machinery：仍以 pathname
  執行一般 git binding/session workflow，但沒有送檔 capability，因此不能把 replacement cwd 變成
  Discord outbound file。
- **可審核的檔案身份**：`secureOpen` 給出的 canonical root-relative path 會一路保留到
  `OutboundFile` 與 agent file approval；卡片同時列出完整 `Path`、檔名、大小及 comment。
  path 含 bidi/control、不可見 Unicode format 字元（含 U+200B）、換行/tab/backtick、會被轉義或截斷的字元、
  或超過完整顯示上限時直接拒絕，不以省略號隱藏尾端；完整 root-relative path 以安全 inline code
  delimiter 顯示，所以同 basename 的不同檔案不會混淆。custom tool 只聲稱從 current session workdir 傳檔，不宣稱檔案由 agent
  生成；重新開檔送出前也比對 path、digest 與 fingerprint。
- **`.git` lexical/internal gate**：Windows 與 Darwin 都以小寫比對 `.git` segments，故 case-insensitive
  APFS/HFS+ 上的 `.GIT` 等拼法同樣拒絕，且在 pathname 預檢與 handle-derived final path 兩層都套用。
- **content digest / endpoint truth**：送出前先固定內容與 digest；成功與否以 Discord 端點回應為準。即使取消發生在送出接近完成時，也只能回報 endpoint 真實結果，不得樂觀宣稱成功。
- **YOLO fast deny + 卡片撤銷**：`discord_send_file` 在 YOLO 下不是「自動允許」，而是立即拒絕並告知改走 `/file`。切入 YOLO 的同一同步步驟會撤銷已核准檔案、deny 尚待 broker 的 file card，且所有 agent-file currentness 都要求 `!yolo`；所以先前卡片的 Allow click 只能是 inert，不能在 YOLO 後送檔。
- **allow-once only**：agent 路徑沒有 repo/session 級常駐授權；每次送檔都重新決定。
- **持久化的保守預留配額**：agent `discord_send_file` 的 24 MiB 總量屬於邏輯 Discord thread 的
  `SessionStore` record；舊 record 遷移為 0。實際呼叫 Discord 前，actor 必須以 persist-first
  compare-and-reserve 寫入下一個總量，CAS 同時比對 thread、session id、generation 與舊總量；
  rebind 一開始同步 suspend 舊 actor 的 file path，rollback 只可替換預期的新 incarnation，
  並以較大總量單調恢復。若新 incarnation 已預留 bytes，舊 actor 保持 file-fenced 而可繼續非檔案回合。
  寫入失敗即不送檔。因此重啟、resume 與 rebind 都不能重開配額。反之，未建立新 incarnation 的
  rollback 會無條件清除仍為 current/active 舊 actor 的**rebind** fence；YOLO 與 abort 仍由
  `/file` lifecycle gate、custom-tool permission/currentness predicate 個別拒絕，不能把暫時狀態
  變成永久停用。
- **`/file` session fence**：命令先捕捉 session identity；resolve 後、傳送期間的
  `Transport.sendFile({canSend})`、及 success reply 前都重查 map identity 與 actor file lifecycle。
  `/end`、rebind 或新 session 取代舊 session 時，transport 走既有 late-cancel/delete 路徑，
  不可留下 attachment success claim。
- **`/end` 對 rebind 的 instance ownership fence**：rebind 會先捕捉舊 `Session` 物件；`/end`
  在第一個 await 前把該實例標記為 ended。rebind 在每個 git／root／SDK async 邊界後，且在 reserve、
  commit、map swap 前，都必須重驗 map identity + ended 標記。若已 stale，只清理本次新建 actor、
  root、record、lease 與 worktree，絕不 rollback 恢復舊 record／lease／file fence；swap 後也以新
  instance 重驗，故 `/end` 永遠優先且不會被晚到的 rebind 重新建立。即使 commit 失敗而非 `/end`
  造成的 rollback，也不能丟棄尚未確認 teardown 的 replacement：保留它與 root，確認後才清 target
  worktree，同時可安全還原舊 record。
- **rebind 舊 incarnation 的雙重所有權帳本**：在可變的主 thread record 被 replacement 覆寫前，先將舊
  immutable `(threadId, sessionId, generation)` binding 寫入 v5 `staleRebinds`，以既有 `blocked`
  terminal state 記錄 `rebind-cleanup-pending`／`rebind-teardown-unconfirmed`。map swap 後，該 actor、
  captured binding、worktree/branch、owner thread 與 cleanup plan 一起留在 `staleRebindActors`；它的
  trusted root 只有在 disconnect **確認**後才可釋放。`/end`、正常 rebind 收尾與 shutdown join 同一個
  bounded disconnect promise：`/end` 即使已清 replacement，也會處理舊 incarnation；確認後只在 rebind
  preflight 曾證明可清、且 `removeWorktreeIfClean` 再次證明安全時移除 worktree。若仍未確認，terminal
  pointer 留在 store，restart 的 `/sessions`／startup leftovers 報告與後續 `/end` 都能看見它；不會把
  possibly-live root/worktree 變成無記錄物件。若 replacement 的 terminal stale row 寫入失敗，tracker
  另持有目標 `creating` reservation 的完整 immutable identity，連同「原 session 仍為 current 時可 restore
  的 record snapshot」或「`/end` 已勝出時只可 remove」計畫；必須先確認 disconnect、再安全清 worktree，
  才以同一 persist-first CAS 同步 reconcile primary fallback 與 paired stale rows。identity mismatch 或寫入
  失敗時兩者與 actor ownership 都保留，並封鎖新 rebind，不能把 target `creating` row 當成一般 previous
  session。`/end` 在第一個 await 前把 restore 計畫翻成 remove，且會 retry 已追蹤的 fallback；restore
  成功才移除 pre-swap `/end` routing marker，避免下一次 `/end` 留下會 restart 的 primary row；沒有 live
  map entry 的後續 `/end` 也必須先 retry tracker，未成功對帳時不可走 generic stale-record reaper 刪掉 fallback。
- **faulted actor 的 Windows root lock**：fault path 的 bounded disconnect 只限制等待時間，不能在
  SDK 尚未確認終止時關閉 retained root。actor 維持 faulted（不能 prompt／送檔），root 作為
  rename/delete fence 留在原處；同一個或稍後 retry 的 disconnect 一旦真的 resolve，才 close 一次
  root，讓 `/end`／shutdown 安全釋放。
- **late attachment retraction truthfulness**：Discord 已接受附件後才 stale 時，transport 會等待有
  上限的 delete；只有 delete 確認才回 `cancelled`。失敗或 timeout 回結構化
  `retraction-unconfirmed`、盡力在原 thread 發不 mention 的「附件可能仍可見」警告；actor 與 `/file`
  將它當 failure，不計入成功送檔額度。若 transport 回 `ok` 後 caller 的最後 lifecycle fence 才
  變 stale，也同樣回「可能已在取消前接受」而非聲稱已取消／收回。
- **schema provenance（v5 stale rebinds）**：帶 `sessions` 的 container 必須有一致的 row schema version；
  v4 container 裡的 v3 row／缺 quota 是 corruption，不是 legacy。v5 的 `staleRebinds` 也必須是
  version-consistent、唯一 immutable identity、`blocked` + `rebind-*` reason 的 terminal rows；不接受
  active stale row（否則 restart 可為同一 Discord thread resume 第二個 actor）。只有明確 v1 bare record
  或版本一致的舊 container 才能遷移，避免手動 downgrade 或 torn write 把 quota 重設為 0。
- **mentions suppression**：所有 attachment sends 都必須保留 `allowedMentions:{parse:[]}`，避免 agent 藉檔案說明或 UI 路徑 ping 人。

### 18.4 平台事實與殘留風險

- **8 MiB 上限**：以 Discord 實際上傳上限為準；超過即拒絕。
- **取消不是回溯刪除保證**：若取消發生在 endpoint 已接近完成時，檔案可能短暫可見；這種 late visibility **不得**被報告成成功，也不得算入每回合的成功送檔計數。
- **保守可用性取捨**：24 MiB 是送出前已持久化的預留總量，不是「Discord 回應成功」後才計的 bytes。
  transport 失敗、取消或 late deletion 仍消耗預留額度；不做 fragile rollback，以免 crash/restart
  使同一 thread 反覆重開配額。代價是未成功的送檔也可能耗盡該 thread 的剩餘額度。
- **thread visibility / CDN expiry**：檔案一旦成功送出，誰看得到由 Discord thread 權限決定；附件 CDN 存續時間與快取失效屬平台行為，本程式只能如實揭露，不能保證立即失效。
- **bounded late deletion / platform availability**：若取消發生在 Discord 已接受附件後，會有上限地等待
  delete；失敗或 timeout 不會稱為已收回，而以 `retraction-unconfirmed` 與可見警告說明附件可能仍
  公開。警告本身也可能因 thread 已刪除而無法送出，故 caller 的 structured failure 才是權威。
- **Windows-only descriptor boundary**：對外 Discord 檔案傳送僅支援 Windows。Windows 依賴 `CreateFileW`
  root handle 排除 delete/rename，因而不能在 proof 與 actor transfer 間替換其 final path。Linux 的
  `/proc/self/fd/<fd>` 與 Darwin 的 `/dev/fd/<fd>` 雖可驗證 retained handle，但 SDK API 只接受 pathname，
  沒有可保證的 fd inheritance/cwd handoff；因此非 Windows 不捕捉 root、不註冊 custom tool，`/file`
  只回覆不可用，正常 session 仍可 create/resume。

### 18.5 §9 測試對照補記

| §9 需求 / 新增風險 | 覆蓋 |
| --- | --- |
| `/channel enable` 缺權限診斷包含 `Attach Files` | `test/app-channels.test.ts` |
| 所有 attachment sends 都 suppress mentions | `test/transport.test.ts` |
| Windows handle-bound validation path、local/worktree git proof、approval key 僅在 descriptor proof 後導出、root swap 拒絕、actor ownership/close-once；非 Windows 不開 root 卻能建立 session | `test/secure-open.test.ts`、`test/binding.test.ts`、`test/app-channels-race.test.ts`、`test/app-rebind.test.ts`、`test/app-reconcile.test.ts`、`test/session-actor.test.ts` |
| Windows `discord_send_file` Allow once / Deny、YOLO fast deny、YOLO 後舊 file card deny/inert、root-relative inline-code card path、同 basename 路徑辨別、U+200B 拒絕、root/content/digest/path 綁定、endpoint truth、late cancellation 不算成功；非 Windows 無 tool 且 `/file` 拒絕 | `test/outbound-file.test.ts`、`test/session-actor.test.ts`、`test/app-file-command.test.ts` |
| 24 MiB 持久化保守預留、舊 record 遷移、session-id + generation CAS、rebind fence/單調 rollback、YOLO/abort rollback 不永久停用 `/file`、restart total、寫入失敗 fail-closed、resume/rebind/new wiring | `test/session-store.test.ts`、`test/session-actor.test.ts`、`test/app-reconcile.test.ts`、`test/app-rebind.test.ts`、`test/app-channels-race.test.ts` |
| `/file` resolve/send interleaving（end、rebind-style replacement）不可附件或成功回覆 | `test/app-file-command.test.ts`、`test/transport.test.ts` |
| `/end` 穿插 rebind 的 binding、replacement actor、map-swap 三階段都不能復活 map／record／worktree；commit rollback 的 unconfirmed replacement 會 retain/retry，terminal stale row 寫入失敗時 target reservation 先作 durable barrier，確認 teardown + worktree cleanup 後只以 target identity CAS restore live original 或在 `/end` 勝出時 remove、並同步移除 paired stale rows；CAS／寫入失敗保留 barrier/tracker、封鎖新 rebind，restart 不 resume fallback creating row；`/end` 會擁有兩個 incarnation 並 retry 已追蹤 fallback，沒有 live map 的後續 `/end` 也不得 generic-reap 未對帳 barrier，restore 後的下一次 `/end` 不可留下 primary row | `test/app-rebind.test.ts`、`test/session-store.test.ts`、`test/app-reconcile.test.ts` |
| faulted/hung SDK disconnect 保留 root lock，確認終止後只 close 一次且 actor 仍拒絕 prompt／送檔 | `test/session-actor.test.ts` |
| 已送出後 delete reject/timeout 的 `retraction-unconfirmed`、thread warning、transport `ok` 後才 stale 的可見性警告、actor failure 與 `/file` 誠實訊息 | `test/transport.test.ts`、`test/session-actor.test.ts`、`test/app-file-command.test.ts` |
| v4 container mixed/downgraded row fail-closed；非 Windows 不診斷 Attach Files；YOLO 普通卡與撤銷檔案卡文字一致 | `test/session-store.test.ts`、`test/app-channels.test.ts`、`test/file-delivery-docs.test.ts` |
| session dispose 後可重新顯示一次 Attach Files 缺權限提示 | `test/transport.test.ts` |
| README / Discord setup 中英雙檔、PLAN 與 instructions 都如實說明 Windows-only availability | `test/file-delivery-docs.test.ts` |

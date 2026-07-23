# 執行計畫 v3：discopilot — Discord 前端控制本機 Copilot（SDK-native）

> **v1 目標（收斂後）**：一個 **Discord frontend for a supported local Copilot SDK session** —
> 從手機/Discord 對一個受控 repo 開一個私密 thread、串流看到 Copilot 輸出、對一個 shell 權限請求
> 檢視並 approve/deny、能 abort。**先把最難的部分（安全隔離 + 互動 broker + 串流去重）做對**，其餘後推。
>
> 已納入 RubberDuck 兩輪（rd-plan、rd-plan2）。SDK 事實均型別驗證。

## 0. 已型別驗證的 SDK 事實
- 套件 `@github/copilot-sdk`，npm 穩定最新 **1.0.6**（1.0.7 為 preview）。**pin 1.0.6 + lockfile + 啟動相容檢查 + 契約測試**。
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
狀態：`PUBLISHING → OPEN → CLAIMED_ACK → SETTLED`；modal 分支 `OPEN → MODAL_OPEN → CLAIMED_ACK → SETTLED`；終態 `TIMED_OUT` / `ABORTED`。
不變式：
- **CAS/claim 同步發生在任何 await 之前**。
- 核准**只在** Discord ack 成功 + generation 仍有效 + 稽核已 commit **之後**才送達 SDK。
- 短 ack 期限：Discord 失敗即安全 deny。
- **單一 finalizer**：清所有 timer、移除 parent/modal map、abort signal、只 resolve 一次。
- 「自己輸入」以 `showModal()` 為**初次**回應；modal 建**一次性 child nonce + 獨立逾時**；未提交終將安全逾時。
- nonce **密碼學隨機、絕不重用**；逾時已終結 server 端條目後，遲到點擊安全（停用元件僅美觀）。
- **控制/broker 流量不得排在被 `session.send()`/turn 阻塞的佇列後**（否則 SDK 等的權限卡片卡在同一 turn 後面 → 死鎖）。
- 逾時預設：Permission 2–5 分→`user-not-available`；ask_user 10–15 分→丟 typed timeout；exit-plan→`{approved:false}`；elicitation→`{action:"cancel"}`。
- `/stop`：先標 `ABORTING` 並**禁止新註冊** → 安全 settle 既有 → 再 `session.abort()`。

## 4. Session 擁有權、復原與 fencing（移到 P2，但規格先定）
- **持久化、交易式遞增的 incarnation/generation**，在每次 create/resume 綁定前 +1；每個 callback/event closure 捕捉它；只有 generation == 現行時才允許 publish/settle/DB 變更。
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
隔離 client/session 生命週期、正規化事件、callback 結果變體、model/context 切換、resume、remote。pin 1.0.6 + lockfile + 啟動相容檢查 + 對安裝 CLI 契約測試。不做多 provider 抽象。

## 7. 從 seam-acp 移植
**重用小原語**：SerialQueue+順序測試、ChoiceBroker 的 timeout/abort/generation 概念、fence/chunk/flush+golden、附件驗證、SQLite WAL、路徑/repo 選擇、health/single-instance+常駐。
**不移植**：ACP runtime/profiles、ask-user MCP+bearer、手工 model/context 探索、ACP compaction、CLI 權限模式參數、chat 抽象、排程/tunnel/gist、龐大 orchestrator。

## 8. 分階段（重排：最小垂直切片先）
- **P0**：scaffold、config schema、**pin 1.0.6 + 相容檢查**、**single-instance guard**、決定 infiniteSessions 政策、決定隔離方式（A 或 B）。驗收：build+空測綠、啟動連 SDK 並 `listModels()`。
- **P1（真正最小垂直切片）**：
  - 單一 owner/guild/父頻道；單一 canonical allowlisted repo；單一私密 thread/session；**手動佈建的受限 worker 環境**（或標 lab-only）。
  - 一 client + 薄 adapter；簡單有界串流 renderer（delta/final 去重 + 分塊）。
  - **註冊全部 4 個 callback**：shell 權限有 approve-once/deny UI；**其餘 9 變體與所有不支援類型 fail-closed（deny/cancel）**。
  - Broker 處理 approve/deny/timeout/重複點擊/abort 競態（第 3 節狀態機）。
  - `/stop`；最小**持久化核准稽核**。
  - **手動啟動、無 resume**；重啟即標 session/interaction interrupted。
  - **驗收**：手機開 thread → 要求 `git status` → 檢視並 approve/deny **確切請求** → 收到串流輸出 → 成功 abort 一個 turn。
- **P2**：resume + reconciliation（第 4 節）+ generation fencing。
- **P3**：其餘 callback UI（ask_user modal、exit-plan、elicitation、memory/mcp/url… 的呈現）。
- **P4**：pickers（/model /effort /context /mode）、queue/steer、usage。
- **P5**：attachments/images 輸入、todo/plan、changed-file/git diff 摘要。
- **P6**：跨平台 installer + 常駐。

## 9. 測試（針對非同步編排）
fake SDK adapter + fake Discord transport + 決定性 clock。必測：逾時只 settle 一次/過期點擊拒絕；未授權與跨 thread 點擊無法 resolve；ack 失敗即 deny；modal 路徑；同/跨 session 併發亂序；shutdown/abort 清空 pending；generation 過期 callback 不生效；delta/final 去重；sub-agent 不交錯；未知權限變體 fail-closed；resume 對帳四種情形；message 404 新 anchor。Live smoke（P1 驗收）+ Restart smoke（P2）。最小 CI（Node22 Win/Ubuntu）。

## 10. 決策紀錄（已定）
1. **隔離方式 = B（先 lab-only）**：不做 controller/worker 分離；P1 只在**可拋棄的 VM/測試帳號/測試 repo**跑；README + 啟動時明確警告「僅限拋棄式環境」。之後再升級到 A。
2. **帳號盜用 = 先靠 Discord MFA**；TOTP/本機 step-up 列為未來強化（非 v1）。
3. **GitHub repo = private，於 P0 建立**（lettucebo/discopilot）。
4. **SDK = pin 1.0.6 穩定** + lockfile + 啟動相容檢查。
5. **P1 受控 repo = 可拋棄測試 repo（待定）**：開始 P1 live 測試前指定或另建一個 throwaway repo；**不對重要 repo**。

## 11. RubberDuck 紀錄
- rd-plan（R1）→ 納入：broker、安全、擁有權/復原、測試、render、adapter、範圍、移植。
- rd-plan2（R2）→ 納入：P1/P2 順序修正（handler 從第一 session 全註冊+fail-closed）、containment invariant、10 權限變體 fail-closed + resolvedByHook 防繞過、broker 明確狀態機、resume 持久化 fencing + 對帳表 + 生命週期、single-instance→P0、v1 最小化垂直切片。
- 殘留非阻塞強化（記錄不做）：per-session microVM、hash-chained 稽核、TOTP、DLP 掃描（皆 defense-in-depth）。

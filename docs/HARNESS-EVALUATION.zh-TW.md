# Harness 評估

> [English](HARNESS-EVALUATION.md) · **繁體中文**

日期：2026-08-24 · 狀態：已決策 · 基準版本：`v1.1.0`（`48aa0e0`）

本次評估檢視的版本：GitHub Copilot CLI `1.0.81-8`、
`@github/copilot-sdk` `1.0.7-preview.3`、Oh My Pi `v18.0.4`（source
`4854db8`）、Paseo `4f79618`。下文引用的 SDK baseline measurement 是以
Copilot CLI `1.0.74-1` 記錄；ACP probe 則以 `1.0.81-8` 執行。

## 1. 為什麼需要這份文件

在繼續投入自製 bridge 之前，本專案先與既有的 Discord agent frontend
比較。目的不是保護已投入的成本，而是尋找不會犧牲硬性需求、可直接取代本
repository 的既有產品。本紀錄把需求、證據、排除的替代方案與決策保存於
產生它們的對話之外。

此決策衍生的實作由
[#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27) 追蹤。
本文件解釋「為什麼」；Issue 解釋「怎麼做」。

## 2. 驅動決策的需求

以下是產品需求，不是對單一實作的事後描述。

| 需求 | 意義 | 困難之處 |
| --- | --- | --- |
| Discord thread = persistent session | 一個 thread 對應一個可跨 restart 延續的長生命週期 agent session。 | Discord message handler 必須保存並 reconcile provider 擁有的 session identity。 |
| Thread = fixed worktree | Thread 永遠 resume 到同一 working directory。 | Repository identity、worktree ownership 與 cleanup 在 crash 後仍須正確。 |
| Multi-repo | 可操作 `REPOS_ROOT` 下任一 repository。 | Bridge 不能只設定一個 checkout。 |
| Same-repo concurrency | 同一 repository 可透過不同 worktree 同時供多個 thread 使用。 | 共用 checkout 會讓檔案與 git 操作競爭。 |
| Real harness | 使用真正的 coding-agent runtime，不重新實作 agent；本評估的目標 harness 是 Copilot 與 OMP。 | Harness 擁有 agent loop、tools、sessions 與 provider-specific 行為。 |
| Long-context models | 可選 large context window，並如實回報容量。**這是決策驅動條件。** | 大型 display label 不代表 request path 實際取得對應 context tier。 |
| Interactive control | Steering、queue、stop、approval、model、thinking、context 與 usage。 | One-shot prompt/reply relay 無法呈現 coding harness 的 live control plane。 |

## 3. Long-context 限制

### 3.1 本專案所稱的「long context」如何衡量

比較基準是執行中的 harness 回報的 effective context window，而不是 model
名稱或 UI suffix：

```text
@github/copilot-sdk + contextTier: "long_context"  ~936K effective
copilot --acp 1.0.81-8, with --context             264K
```

SDK 數值是在真實 Copilot Enterprise session 上量測，並記錄於
[基準 README](https://github.com/lettucebo/discord-copilot-sdk/blob/48aa0e09aa1ad4dfbe56180eba945b5cf59680bd/README.md#why-the-sdk-verified)。
應用程式在
[基準 session actor](https://github.com/lettucebo/discord-copilot-sdk/blob/48aa0e09aa1ad4dfbe56180eba945b5cf59680bd/src/copilot/session-actor.ts#L545-L576)
將 `contextTier` 傳給 SDK。264K ACP 結果可依 [§7](#7-可重現的證據附錄)
重現。

這些是指定版本與 account policy 的觀測值，不是所有 model 的通用承諾；
runtime model capabilities 仍是權威來源。

### 3.2 OMP 的 `-1m` model 實際是什麼

OMP 從 GitHub Copilot catalog 合成 long-context sibling，不會把 synthetic ID
送給 Copilot：

```text
OMP catalog id                        claude-opus-5-1m
provider requestModelId               claude-opus-5
OMP contextWindow                     1,000,000
Copilot long_context effective tier     936,000
```

此 mapping 由 OMP 固定版本的
[`issue-6664-repro.test.ts`](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/catalog/test/issue-6664-repro.test.ts)
與
[GitHub Copilot model-limit tests](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/catalog/test/github-copilot-model-limits.test.ts)
主張。
[Synthesis source](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/catalog/src/provider-models/openai-compat.ts#L5543-L5577)
將它描述為 client-side context budget，而非 served model ID，並以
`Math.min(fullContextWindow, longContextMax + maxTokens)` 計算
`contextWindow`：936,000 prompt tokens 加上 64,000 maximum output tokens，
在 `fullContextWindow` 也是 1,000,000 的固定 fixture 中，得到 1,000,000
application window。本次評估驗證 catalog implementation，沒有實測真實 OMP
turn 達到該上限。因此 Paseo 使用 OMP 時顯示 `(1M)` 的 picker，是在 render
OMP 的 catalog；這不代表 stock `copilot --acp` 會 advertise 或接受
`claude-opus-5-1m`。

## 4. 評估過的候選方案

### 4.1 `discord-copilot-sdk`（現行方案）

**它是什麼。** 使用官方 `@github/copilot-sdk` 的 Discord frontend，具備
durable thread/session record 與 per-thread git worktree。

**它提供什麼。** 固定基準版本已為 Copilot 實作 §2 全部需求，包括 native
permission 與 user-input callbacks、steering、application queue、stop、
model/effort/context controls、usage、restart reconciliation、multi-repo routing
與 same-repo worktree isolation。基準行為與量測的 long context 記錄在
[README](https://github.com/lettucebo/discord-copilot-sdk/blob/48aa0e09aa1ad4dfbe56180eba945b5cf59680bd/README.md#why-the-sdk-verified)，
並完整列於
[#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27)。

**它的成本。** 專案必須自行維護 Discord orchestration，且目前只有一個
harness implementation。

**判定：保留。** 它是唯一已滿足完整需求集合的候選方案。

### 4.2 Paseo daemon + `@getpaseo/client`

**它是什麼。** 具備 TypeScript client 的通用本機 coding-agent daemon。
Paseo 管理 sessions、provider integrations、workspaces 與 worktrees。

**它提供什麼。** Daemon 具有 cancellation、permission response、model 與
thinking 操作。然而受評估 commit 中，`createPaseoClient()` 的 stable
high-level `PaseoAgentHandle` 提供 refresh、send/run/wait、archive、detach、
subscribe、同步 `current()` snapshot 與 timeline handle，但沒有 cancellation、
permission-response、model 或 thinking 操作
（[source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/client/src/index.ts#L248-L276)）。
較低階的操作只能從明確命名為 `./internal/daemon-client` 的 package export
取得；它是三個 `./internal/*` exports 之一
（[package metadata](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/client/package.json)）。

**它的成本。** Production Discord adapter 必須依賴 internal API，或重新建立
high-level client 缺少的 controls 與 permission UX。

**判定：單獨使用不可行。** Stable high-level client 暴露完整 live control
plane 時再重新評估。

### 4.3 Paseo daemon + OMP RPC provider

**它是什麼。** Paseo 具有基於 OMP JSONL RPC transport 的非 ACP OMP
provider。其評估版本 runtime 實作 prompt、abort、model、thinking、usage、
steering、follow-up、host tools 與 session 操作
（[runtime source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/server/src/server/agent/providers/omp/cli-runtime.ts)）。

**它提供什麼。** OMP model discovery 可暴露 §3.2 所述、由 catalog assertion
支持的 synthetic 1M variant，而 Paseo 提供 daemon 與 worktree
infrastructure。本次沒有實測該容量的真實 OMP turn。

**它的成本。** 仍需自製 Discord thread/session 與 approval adapter。它也無法
提供需求中的 Copilot harness path：Paseo Copilot provider 明確執行
`copilot --acp`
（[source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/packages/server/src/server/agent/providers/copilot-acp-agent.ts)）。

**判定：延後的替代方案。** OMP 能力完整，但 migration 會替換已運作的
orchestration，仍需自製 Discord 功能，而且 Copilot 仍受 ACP 阻擋。

### 4.4 Paseo Hub Discord integration

**它是什麼。** `discord.mention` 會啟動 workflow 並貼出允許的
`discord.reply` 的 automation layer。

**它提供什麼。** Declarative routing、filters、time limits、agent selection
與可稽核 automation。評估版本文件定義一個 trigger 及其啟動的 ordered steps
（[workflow source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/public-docs/hub/workflows.md)）
和 Discord mention/reply workflow
（[Discord source](https://github.com/getpaseo/paseo/blob/4f796181bf9d7e6b5ea2067ece4eace7213938cb/public-docs/hub/triggers/discord.md)）。

**它的成本。** 每次 mention 是 workflow execution，不是 thread 擁有的
durable interactive coding session。文件中的 Discord surface 沒有
thread-to-worktree identity、live steering queue、cancellation 或 permission
round trip。

**判定：僅用於 automation。** 可與本產品並用，不能取代本產品。

### 4.5 `seam-acp`

**它是什麼。** 最接近需求的既有 Discord coding-agent bridge：每個 thread
一個 agent session、repository picker、cancellation、steering、model/mode/
effort controls 與 Discord permission prompts
（[pinned README](https://github.com/jbulpitt/seam-acp/blob/d0a720fda5d4f7f5b9d262b3d73de774e98544b8/README.md)）。

**它提供什麼。** 成熟的 multi-agent Discord UX，包含許多相同的互動需求。

**它的成本。** Runtime 刻意以 ACP 為基礎，Copilot profile 會 spawn
`copilot --acp`。§7 證明受測 path 無法選擇 Copilot long context。

**判定：依 §6.3 的 ACP 限制排除。** ACP 若取得經驗證的 long-context
parity，它會是最值得重新評估的 migration 候選。

### 4.6 Direct OMP RPC-UI + custom Discord adapter

**它是什麼。** 直接 spawn `omp --mode rpc-ui`，把 JSONL commands/events
映射到既有 Discord/session/worktree infrastructure。固定版本的
[CLI flag table](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/coding-agent/src/cli/flag-tables.ts)
確認 OMP 接受 `rpc-ui`，雖然 protocol guide 是由較簡單的 `rpc` mode
開始介紹。OMP 在固定版本的
[RPC contract](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/docs/rpc.md)
與
[types](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/packages/coding-agent/src/modes/rpc/rpc-types.ts)
記錄 model 與 thinking changes、steering、follow-up、abort、state、session
resume 與 context statistics。

**它提供什麼。** 真正、非 ACP 的 OMP harness，具備 OMP synthetic
long-context catalog 與完整 interactive control plane。OMP path 是否能發布，
仍取決於 #27 的 runtime-discovery 與 live-smoke gates。

**它的成本。** 必須建置並維護 adapter、process supervision、typed frame
validation、permission broker 與 provider-neutral harness abstraction。

**判定：採用為演進路線。** 在 Copilot SDK harness 旁新增，不取代已運作的
產品；implementation contract 是
[#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27)。

### 4.7 `agy-discord-mcp`

**它是什麼。** Antigravity `agy` CLI 的 Discord relay 與 MCP tool surface。

**它提供什麼。** Discord access control、per-channel conversation resume、
file delivery 與 MCP tools。

**它的成本。** Relay mode 執行 `agy --print`；wrapper 會 inject
`--dangerously-skip-permissions`，因此所有 tool 都 auto-approved。它也沒有
git worktree ownership 或 Copilot/OMP long-context control
（[pinned README](https://github.com/Openclaw-Metis/agy-discord-mcp/blob/4d490efcb724805c4c8af44f63138e8baab57231/README.md)）。

**判定：拒絕。** 它採用不同 harness，approval 與 repository-isolation model
也較弱。

### 4.8 Pi Discord bridge family

原始研究把「Piscord」與「pi-discord-bridge」視為沒有可用專案的名稱。
2026-08-24 重新搜尋 repository 後證明該說法錯誤。現在已有數個基於
upstream Pi、整合 `@earendil-works/pi-coding-agent` package 的真實 bridge。
Crokily 透過 `pi` binary 執行 agent turns；notdezzi 也使用該 binary 作為
detached new-session launcher：

- [`Crokily/pi-discord-gateway`](https://github.com/Crokily/pi-discord-gateway/tree/72df4f0e035da284cfaf743d45b87555d7112721)
  （`piscord`）具備 per-channel persistence、queueing、working-directory
  overrides、model 與 thinking controls。
- [`joelhooks/pi-discord-threads`](https://github.com/joelhooks/pi-discord-threads/tree/947ab38704aa89648fae37f30e0dd51478c2cd7d)
  具備 durable Discord thread records、steering、follow-up 與 cancellation。
- [`frankhildebrandt`](https://github.com/frankhildebrandt/pi-discord-bridge/tree/c189f8b5baef4f031733527e30f4057fd4e89ae2)、
  [`rpo130`](https://github.com/rpo130/pi-discord-bridge/tree/454490e1c7aea2d66b862535aecea4f6256c549d)
  與
  [`notdezzi`](https://github.com/notdezzi/pi-discord-bridge/tree/14c2572b00b319c255e8c2036ee69f1618ac5470)
  bridges 提供不同組合的 session persistence、abort、compact、model、thinking
  與 usage。

OMP 本身是
[Pi 的 fork](https://github.com/can1357/oh-my-pi/blob/4854db856c20e000a3760d793c56d78065dcf83f/README.md#the-pi-you-love-with-batteries-included)，
所以這些專案是相近的架構親屬，而非無關工具。五個專案全都與
`@earendil-works/pi-coding-agent` package 耦合：`joelhooks` 與
`frankhildebrandt` 宣告 direct dependencies，`Crokily`、`rpo130` 與
`notdezzi` 宣告 peer dependencies。`Crokily/pi-discord-gateway` 是 hybrid：
它另外以 `pi` binary 執行 agent turns，同時從 package import `AuthStorage`、
`ModelRegistry` 與 `SettingsManager` 進行 model discovery。OMP 發布
`@oh-my-pi/pi-coding-agent`；本次沒有測試 drop-in package compatibility，
也沒有測試在 package integration 仍使用 upstream Pi 時，改以 `omp` 執行
Crokily turns。受評估的實作都沒有同時提供 fixed git worktree、approval
round trip 與經驗證的 long-context-tier selection。

**判定：有價值的參考，不是替代方案。** 它們的存在修正了先前搜尋結論，但
其 harness 與 isolation boundary 不滿足 §2。將 upstream Pi 嵌入本 repository
既有 Discord/worktree infrastructure，仍是延後評估的 adapter alternative；
選擇 OMP，是因為固定版本的 OMP fork 提供 RPC-UI 與 §3.2 評估的 GitHub
Copilot catalog，而 upstream Pi package 尚未證明具備該組合。

### 4.9 Custom ACP-to-Copilot-SDK proxy

**它是什麼。** 新建一個 ACP server，advertise synthetic `(1M)` choices，
但在 protocol 背後以 `contextTier: "long_context"` 驅動
`@github/copilot-sdk`。

**它提供什麼。** 可讓 ACP client 顯示並選擇現行方案已使用的相同 SDK 能力。

**它的成本。** 它不是 stock `copilot --acp`，而是另一個自製 harness
adapter，必須負責 session、permission、model 與 compatibility。它增加
protocol layer，卻未降低本專案維護負擔。

**判定：記錄但不採用。** 直接保留 SDK 並加入 OMP RPC-UI 的 moving parts
較少。

## 5. Capability matrix

`✅` 表示受評估產品直接提供該需求；`⚠️` 表示部分支援或需要 custom adapter；
`❔` 表示未評估；`❌` 表示引用的候選設計不提供。ACP 狀態由 §3 推導，不作為
獨立需求重複評分。標示「reuse current」的 columns 評估
incumbent-plus-adapter path；其他 product columns 則以 standalone replacement
評估。

| 需求 | 現行方案 | Paseo client | Paseo + OMP | Hub | seam-acp | direct OMP | agy relay | Pi bridges | ACP→SDK proxy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Persistent Discord thread session | ✅ | ⚠️ adapter | ⚠️ adapter | ❌ execution | ✅ | ⚠️ build | ⚠️ channel | ⚠️ mixed | ⚠️ build |
| Fixed per-thread worktree | ✅ | ⚠️ adapter binding | ⚠️ adapter binding | ❌ | ❔ not evaluated | ✅ reuse current | ❌ | ❌ | ✅ reuse current |
| Multi-repo + same-repo concurrency | ✅ | ✅ daemon | ✅ daemon | ⚠️ workflow routing | ⚠️ repo sessions | ✅ reuse current | ❌ fixed cwd | ⚠️ mixed, no worktrees | ✅ reuse current |
| Real harness | ✅ Copilot SDK | ✅ provider-dependent | ✅ OMP | ✅ provider-dependent | ✅ Copilot via ACP | ✅ OMP | ✅ agy | ✅ Pi | ✅ Copilot SDK |
| Verified selectable long context | ✅ ~936K | ⚠️ OMP catalog only | ⚠️ catalog-asserted, not session-measured | ❌ no session control | ❌ ACP 264K | ⚠️ catalog-asserted, not session-measured | ❌ | ❔ not evaluated | ⚠️ custom |
| Full interactive controls | ✅ | ⚠️ internal API | ✅ daemon, adapter needed | ❌ | ✅ except long context | ✅ RPC, adapter needed | ❌ auto-approved | ⚠️ varies | ⚠️ build |

## 6. 決策

1. **保留 `discord-copilot-sdk` 作為產品。** 它是唯一已滿足所有硬性需求的
   候選，包括實測的 long-context Copilot session。
2. **演進為 dual-harness architecture。** 保留 `@github/copilot-sdk`，並依
   provider-neutral session contract 加入 direct OMP RPC-UI，如
   [#27](https://github.com/lettucebo/discord-copilot-sdk/issues/27) 所定義。
   這可重用最困難的 Discord、worktree、persistence 與 approval
   infrastructure，而不是圍繞 Paseo 再建一次。
3. **當 stock `copilot --acp` 無法呈現 verified long context 時，排除 stock
   ACP-backed route。** §4.9 的 custom ACP-to-SDK proxy 另因增加 protocol 與
   maintenance layer、卻沒有移除 custom harness 工作而被拒絕。`omp acp`
   也不採用：OMP RPC-UI 已直接暴露 adapter 所需的 tool cards、selectors 與
   dialogs，ACP 只會增加 protocol layer，不會增加 control-plane capability。
   下方 probe 與 §8 trigger 定義何時重新評估 stock Copilot ACP。

## 7. 可重現的證據附錄

### 7.1 Stock Copilot ACP catalog 與 configuration probe

在空目錄中使用 Node.js 與已登入的 Copilot CLI 執行：

```javascript
// npm install @agentclientprotocol/sdk
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const child = spawn("copilot", ["--acp", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const connection = new acp.ClientSideConnection(() => ({
  async requestPermission() { return { outcome: { outcome: "cancelled" } }; },
  async sessionUpdate() {},
}), stream);

await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });

console.log("models:", session.models.availableModels.map((m) => m.modelId));
console.log("configOptions:", session.configOptions.map((o) => o.id));

for (const [configId, value] of [["model", "claude-opus-5-1m"], ["contextTier", "long_context"]]) {
  try {
    await connection.setSessionConfigOption({ sessionId: session.sessionId, configId, value });
    console.log(configId, "accepted");
  } catch (error) {
    console.log(configId, "rejected:", error.message);
  }
}

child.stdin.end();
child.kill();
```

使用 Copilot CLI `1.0.81-8` 的觀測結果：

1. Advertise 24 models；ID 或名稱包含 `1m`、`1M` 或 `long` 的數量為 **零**。
2. `model = claude-opus-5-1m` → `Invalid model 'claude-opus-5-1m'.`
3. `contextTier = long_context` → `Unknown config option 'contextTier'.`

### 7.2 ACP startup flag probe

結果 4 需要真實 turn，並非上述 catalog script 的輸出：

1. 將 `COPILOT_HOME` 設為新的空 throwaway directory。
2. 將 child arguments 改為
   `["--acp", "--stdio", "--model", "claude-opus-5", "--context", "long_context"]`。
3. 建立 ACP session，送出一個一般 prompt，使 agent context 初始化。
4. 將 `/context` 作為下一個 prompt 送出並檢查 reply。
5. 刪除 throwaway directory。

必須使用隔離的 home，因為 `--context` 會把選擇的 tier 寫入
`settings.json`；若使用 operator 的一般 home，會改變後續 runs。

觀測輸出：`16k/264k tokens`。

誠實性註記：`/context` 把 model 標示為 `claude-sonnet-5`，但 ACP session
回報 `currentModelId: claude-opus-5`，所以該 label 不可靠。關鍵觀測是 264K
window，且受到上述 catalog 與兩次被拒絕的 configuration write 交叉驗證。

上游以
[`github/copilot-cli#4275`](https://github.com/github/copilot-cli/issues/4275)
追蹤缺少的 ACP option；該 Issue 在 2026-08-24 狀態為 OPEN，標題是
“ACP: expose contextTier as a session config option (parity with interactive
/model picker).”

### 7.3 Repository search 修正

下列 discovery commands 也在 2026-08-24 重新執行：

```powershell
gh search repos Piscord --limit 100 --json fullName
gh search repos pi-discord-bridge --limit 100 --json fullName
```

兩者分別回傳 22 與 14 個 repositories，包含 §4.8 的 Pi coding agent
bridges。因此本紀錄不會重複先前「這些名稱沒有對應專案」的錯誤結論。

## 8. 什麼情況會改變此決策

Durable decision 留在本文件；會變動的 dependency state 與精確重測步驟放在
[#28](https://github.com/lettucebo/discord-copilot-sdk/issues/28)。

下列任一具名 trigger 發生時重新評估：

- Copilot ACP 暴露並接受 `contextTier`。
- Copilot ACP advertise 並成功執行 long-context model。
- OMP 變更 RPC-UI 或 synthetic long-context model contract。
- OMP release 記錄與使用 `@earendil-works/pi-coding-agent` 的 Pi extension
  相容，或受評估的 Pi bridge 記錄支援 `@oh-my-pi/pi-coding-agent` 或以
  `omp` 執行 turns。
- 使用 GitHub Copilot provider 的真實 OMP session 驗證 discovered `-1m`
  variant、reported context window 與 effective long-context behavior。
- Copilot SDK preview 破壞已驗證的 SDK-native path。
- Paseo 將所需 controls 從 internal daemon client 提升至 stable high-level client。
- Pi/OMP Discord bridge 補齊 fixed-worktree、approval 與 verified long-context
  guarantees。

在 trigger 經由真實 session 而非 label 證明前，§6 決策維持有效。

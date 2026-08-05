# 頻道存取

> [English](CHANNEL-ACCESS.md) · **繁體中文**

這份文件是權威模型：bot 的指令在哪裡出現、bot 在哪裡被允許動作，以及為什麼這兩件事是不同決策。

---

## 1. 兩個平面，以及為什麼 bot 不能藏自己的指令

| 平面 | 由誰設定 | 控制什麼 | 是安全邊界嗎？ |
| --- | --- | --- | --- |
| Discord | 伺服器管理員，在 Server Settings → Integrations | 指令是否**出現在** `/` 選單 | **否** |
| Bot | 擁有者，用 `/channel` | bot 是否**採取動作** | **是** |

Discord 的選單顯示是看使用者在該頻道的 `USE_APPLICATION_COMMANDS` 權限加上 Application Command Permissions v2，不是看 bot 的 `VIEW_CHANNEL` 權限（[來源](https://docs.discord.com/developers/interactions/application-commands#application-command-permissions-object-using-default-permissions)）。**bot token 不能**呼叫 command-permissions endpoint；Discord 要求帶有 `applications.commands.permissions.update` 的 OAuth2 bearer token，也就是必須有人類授權（[來源](https://docs.discord.com/developers/interactions/application-commands#permissions)）。所以這個 bot 永遠不能自己把自己的指令藏起來。

Interaction 也會不受頻道權限影響送到 bot，而且初始 interaction 回應不需要 `SEND_MESSAGES`（[來源](https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction)）。因此 bot 自己的 `/channel` gate 才是真正的授權邊界。如果 bot 對禁止的 interaction 完全不回答，Discord 會在 3 秒後顯示 "The application did not respond"；所以 ephemeral refusal 是最安靜且合法的回應（[來源](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback)）。

---

## 2. Discord 平面 — 隱藏指令（管理員、一次性、每個伺服器）

到 Server Settings → Integrations → 該 app → Command permissions。先對 **All Channels** 拒絕這個 app，再只允許工作頻道。

這個設定會跨 bot 重啟保留。bot 每次啟動都會對 guild commands 做 bulk-`PUT`；Discord 的 bulk overwrite 會用 command **name** 比對既有指令，名字不變時會保留 command ID（[來源](https://docs.discord.com/developers/interactions/application-commands#bulk-overwrite-guild-application-commands-json-params)）。因為名字不變的指令不是新建，也不會消耗每個 guild 每天 200 次 create 的額度（[來源](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)）。

---

## 3. Bot 平面 — `/channel`

指令介面：

- `/channel enable [channel:<id or #mention>]` — 啟用目前頻道，或指定的頻道。`channel:` 是**字串** option，所以也接受 raw ID，風格和既有 `/end thread:<id>` 一樣。
- `/channel disable [channel:<id or #mention>]`
- `/channel list`

規則：

- 只有在 `DISCORD_ALLOWED_USER_IDS` 裡的使用者可以執行 `/channel`。
- 目標必須是設定 guild 裡一般的**文字頻道**。Threads、forum channels、announcement channels 和 voice channels 都會被拒絕。
- `DISCORD_PARENT_CHANNEL_ID` 是**種子**頻道：永遠啟用，對它執行 `/channel disable` 會被拒絕。要改它請改 `.env` 並重啟。
- `enable` 會回報 bot 在該頻道缺少的權限：View Channel、Send Messages、Create Public Threads、Send Messages in Threads、Embed Links、Read Message History；但仍然會啟用，因為權限不是授權。Manage Threads 只用於 `/new` 失敗後的清理，是選用權限，這個檢查不會要求或回報它。
- `disable` 在該頻道仍有進行中的 session，或儲存的 `active`／`creating` 記錄時會**拒絕**。請先用 `/end` 結束它們。這是刻意的：bot 不會為了整理而摧毀工作。
- `/channel list` 只顯示 **bot 授權**。它不表示 Discord 是否顯示指令。

登錄檔位於 `~/.discord-copilot-sdk/<instance>.channels.json`。如果登錄檔損毀，或屬於外部 guild，bot 會**拒絕啟動**，而不是靜默退回種子頻道。靜默 fallback 會把所有其他頻道的 session 標成 `blocked`，而且不可逆。解除安裝器會把這份登錄檔和其他狀態目錄一起移除。

---

## 4. 操作順序

這是最容易弄錯的地方：管理員的 deny-all 也會把 `/channel` 自己藏起來。

- **新增頻道**：管理員先在 Integrations 允許該頻道 → 擁有者在該頻道執行 `/channel enable`。如果目標頻道仍然看不到指令，就改從**種子頻道**執行 `/channel enable channel:<id>`。
- **移除頻道**：先用 `/end` 結束該頻道的 sessions → `/channel disable` → 管理員在 Integrations 拒絕該頻道。

---

## 5. 來自第二個 app 的重複指令

如果兩個 Discord applications（例如 `DisPilot` 與 `DisPilot-Test`）都在同一個伺服器，兩者都會註冊自己的 `/new`、`/diff`、`/context` 等指令。選單會分別列出它們，並標上各自的 app。

多個 app 可以合法共用 command names，而平台沒有任何方式讓其中一個從另一邊壓掉對方（[來源](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)）。唯一修法：把第二個 app 從伺服器移除，或在 Integrations 把它限制到自己的測試頻道。

---

## 6. `blocked` 是終態

如果頻道在仍有 sessions 指向它時離開 enabled set，例如手改登錄檔、改了 `.env` 的種子、或 store 損毀，這些 session records 會在下次啟動時被標成 `blocked`。重新啟用該頻道**不會**復活它們。

請用 `/end thread:<id>` 清掉；git 證明 worktree 乾淨時，也會一併回收 worktree。

---

## 7. 驗收 — 正反兩邊都要做

- **正向**：在已啟用頻道，`/` 會列出指令，`/new` 會開討論串，並且在討論串打字會收到回覆。
- **反向**：在沒有啟用的頻道，`/` **不應該**列出指令。如果因為缺了管理員步驟而仍然可以呼叫指令，你只會得到 ephemeral refusal —— bot 不會做任何事。

**只有反向測試才能證明你真正想要的東西。**

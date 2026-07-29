# Discord Bot 設定指南 / Discord Bot Setup

建立 bot、開啟正確的 intent、用正確的權限邀請它，並取得 `.env` 需要的四個 ID。
Create the bot, enable the right intent, invite it with the right permissions, and collect the four IDs `.env` needs.

> 這份文件只處理 **Discord 那一側**。裝好之後請回到 [`INSTALL.md`](../INSTALL.md)。
> This covers the **Discord side** only. When you're done, go back to [`INSTALL.md`](../INSTALL.md).

最後你會得到 `.env` 的這四個值 / You will end up with these four values:

```
DISCORD_BOT_TOKEN=          # 步驟 3 / step 3
DISCORD_ALLOWED_USER_IDS=   # 步驟 5 — 你自己的 user ID / your own user ID
DISCORD_GUILD_ID=           # 步驟 5 — 伺服器 ID / server ID
DISCORD_PARENT_CHANNEL_ID=  # 步驟 5 — 父頻道 ID / parent channel ID
```

---

## 0. 先建一個私人伺服器 / Start with a private server

Discord → 左側 **+** → **Create My Own** → **For me and my friends**。
Discord → **+** on the left → **Create My Own** → **For me and my friends**.

在裡面建立一個**文字頻道**（例如 `#copilot`）當作父頻道。所有 session 都會是這個頻道底下的討論串。
Create a **text channel** in it (e.g. `#copilot`) to act as the parent. Every session becomes a thread under it.

> **為什麼要私人伺服器**：這個 bot 會以你的身分執行 shell 指令。任何看得到這個頻道的人都能看到 agent 的輸出（包含檔案內容）。輸入有 allow-list 保護，**輸出沒有**。
> **Why private**: the bot runs shell commands as you. Anyone who can read the channel can read the agent's output, including file contents. Input is allow-listed; **output is not**.

---

## 1. 建立 Application 與 Bot / Create the application and bot

1. 前往 <https://discord.com/developers/applications> → **New Application** → 取名（這個名字會顯示在 Discord 上）。
   Go to <https://discord.com/developers/applications> → **New Application** → name it (this is the name shown in Discord).
2. 左側 **Bot** 分頁。較新的介面會自動建立 bot；若沒有就按 **Add Bot**。
   Open the **Bot** tab. Newer portals create the bot automatically; otherwise click **Add Bot**.

---

## 2. ⚠️ 開啟 Message Content Intent（最多人卡在這裡）/ Enable the Message Content Intent (the #1 gotcha)

**Bot** 分頁 → **Privileged Gateway Intents** → 打開 **MESSAGE CONTENT INTENT** → **Save Changes**。
**Bot** tab → **Privileged Gateway Intents** → turn on **MESSAGE CONTENT INTENT** → **Save Changes**.

這個 bot 連線時會要求三個 intent（`src/app.ts`）：`Guilds`、`GuildMessages`、`MessageContent`。前兩個不需申請，**`MessageContent` 是特權 intent，必須在這裡手動打開**。
The bot connects with three intents (`src/app.ts`): `Guilds`, `GuildMessages`, `MessageContent`. The first two are free; **`MessageContent` is privileged and must be toggled on here**.

沒開會怎樣：bot 顯示在線、slash 指令也能用，但**你在討論串裡打字它完全沒反應** —— 因為它收得到訊息事件，卻讀不到內容。
If it's off: the bot shows online and slash commands work, but **it silently ignores everything you type in a thread** — it receives the message event with empty content.

> 其他兩個特權 intent（Presence、Server Members）**不需要**開。
> The other two privileged intents (Presence, Server Members) are **not** needed.

---

## 3. 取得 Bot Token / Copy the bot token

**Bot** 分頁 → **Reset Token** → 複製。**只會顯示這一次。**
**Bot** tab → **Reset Token** → copy it. **It is shown only once.**

- 這是密碼等級的東西：拿到的人就能以這個 bot 的身分做任何事。/ Treat it as a password: whoever holds it *is* the bot.
- **不要**提交進版控。`.env` 已在 `.gitignore`，安裝器也會拒絕寫入被追蹤的 `.env`。/ **Never** commit it.
- 外洩了就回這裡 **Reset Token**，舊的立刻失效。/ If it leaks, **Reset Token** here; the old one dies immediately.

---

## 4. 邀請 Bot 進伺服器 / Invite the bot

把下面網址中的 `YOUR_APP_ID` 換成 **General Information** 分頁的 **Application ID**：
Replace `YOUR_APP_ID` below with the **Application ID** from the **General Information** tab:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=326417599488
```

在瀏覽器開啟 → 選你的伺服器 → **Authorize**。
Open it in a browser → pick your server → **Authorize**.

### 這串數字是什麼 / What that number is

`permissions=326417599488` 就是下面這些權限。這個數字已向 Discord API 驗證過，會**原樣**解析成這一組、不多不少。
`permissions=326417599488` is exactly the set below. The integer was verified against the Discord API: it round-trips to precisely these permissions, no more.

| 權限 / Permission | 為什麼需要 / Why |
| --- | --- |
| View Channel | 看得到父頻道 / see the parent channel |
| Send Messages | 一般 bot 慣例會給；這個 bot 自己的訊息**只發在討論串**，父頻道的回覆都是 ephemeral 互動回應。想再精簡的話這是第一個可以試著拿掉的 / conventionally granted; this bot's own messages go **only into threads** (parent-channel replies are ephemeral interaction responses). If you want to trim further, this is the first one to try removing |
| Embed Links | 權限卡片是 embed / approval cards are embeds |
| Read Message History | 串流輸出時要編輯自己先前的訊息 / edit its own earlier messages while streaming |
| Create Public Threads | `/new` 開討論串 / `/new` opens a thread |
| Send Messages in Threads | **在討論串發言**（`Send Messages` 對討論串無效）/ **talk in threads** (`Send Messages` has no effect there) |
| Manage Threads | 只用在一件事：`/new` 失敗時清掉剛建的空討論串 / one job only: deleting the empty thread left by a failed `/new` |

**想給更少權限**：拿掉 `Manage Threads`，改用 `permissions=309237730304`。所有功能照常，**唯一差別**是 `/new` 中途失敗時會留下一個空討論串要你自己刪。
**Want to grant less**: drop `Manage Threads` and use `permissions=309237730304`. Everything still works; the **only** difference is that a failed `/new` leaves an empty thread for you to delete.

> 改討論串名稱（自動命名與 `/rename`）**不需要** `Manage Threads` —— Discord 允許討論串的建立者改自己的討論串名稱，而討論串正是這個 bot 建的。
> Renaming threads (auto-title and `/rename`) does **not** need `Manage Threads` — Discord lets a thread's creator rename it, and the bot is the creator.

`scope=bot applications.commands` 兩個都要：`bot` 是 bot 本身，`applications.commands` 才能註冊 `/new`、`/stop` 這些指令。
Both scopes are required: `bot` for the bot user, `applications.commands` so it can register `/new`, `/stop`, and the rest.

---

## 5. 取得四個 ID / Collect the four IDs

先開啟開發者模式：**User Settings → Advanced → Developer Mode**。
Turn on **User Settings → Advanced → Developer Mode** first.

| 要填的欄位 / Field | 怎麼拿 / How |
| --- | --- |
| `DISCORD_GUILD_ID` | 右鍵伺服器圖示 → **Copy Server ID** |
| `DISCORD_PARENT_CHANNEL_ID` | 右鍵你的文字頻道 → **Copy Channel ID** |
| `DISCORD_ALLOWED_USER_IDS` | 右鍵**你自己的名字** → **Copy User ID** |
| `DISCORD_BOT_TOKEN` | 步驟 3 / from step 3 |

- 父頻道必須是**文字頻道**（不能是分類、論壇或語音）；bot 啟動時會檢查。/ The parent must be a **text channel** (not a category, forum, or voice channel); the bot checks this.
- `DISCORD_ALLOWED_USER_IDS` 是逗號分隔，但 v1 建議**只放你自己**。清單外的人即使在同一個頻道也無法下指令。/ Comma-separated, but v1 should be **just you**. Anyone not listed cannot drive the bot even in the same channel.

---

## 6. 驗收 / Verify

回到專案資料夾照 [`INSTALL.md`](../INSTALL.md) 裝好、啟動後：
After installing and starting per [`INSTALL.md`](../INSTALL.md):

1. bot 在成員清單顯示**在線** / the bot shows **online** in the member list
2. 在父頻道打 `/` → 看得到 `/new`、`/stop`、`/usage` 等指令 / typing `/` in the parent channel lists `/new`, `/stop`, `/usage`, …
3. `/new` → 開出一個新討論串 / `/new` opens a new thread
4. 在討論串打「hello」→ **有回應**（沒回應 = 步驟 2 的 intent 沒開）/ type "hello" in the thread → **you get a reply** (no reply = the step-2 intent is off)

---

## 7. 疑難排解 / Troubleshooting

| 症狀 / Symptom | 原因 / Cause |
| --- | --- |
| bot 在線，但討論串裡打字沒反應 / online but ignores thread messages | **Message Content Intent 沒開**（步驟 2）/ the privileged intent is off |
| 打 `/` 看不到指令 / no slash commands | 邀請時少了 `applications.commands` scope → 用步驟 4 的網址重新邀請一次 / missing scope; re-invite with the step-4 URL |
| `/new` 說 Missing Permissions | 少 `Create Public Threads`，或頻道權限覆寫擋掉了 bot / missing that permission, or a channel-level overwrite blocks the bot |
| 討論串開了但 bot 不說話 / thread opens but the bot is mute in it | 少 `Send Messages in Threads`（`Send Messages` 對討論串無效）/ missing that permission |
| 指令回「Not authorized」 | `DISCORD_ALLOWED_USER_IDS` 不是你的 user ID / not your user ID |
| 指令只在某些伺服器出現 | 指令是註冊到 `DISCORD_GUILD_ID` 那個伺服器的 / commands are registered to that one guild |

---

## 8. 在第二台電腦安裝 / Installing on a second computer

**不要**兩台同時用同一個 token 跑。/ Do **not** run the same token on two machines at once.

Bot 靠一個**本機** PID 鎖來避免重複啟動，它看不到別台機器（`src/core/single-instance.ts`）。實測：兩個實例同時連線時，`/new` 會被**其中一個**接走 —— 而且不是固定的哪一個（測兩次分別由不同實例處理）。由於每台機器有自己的 `CONTROLLED_REPO_PATH` 和自己的核准規則，你會無法預期指令到底跑在哪台機器、動到哪個 repo。
The bot's single-instance guard is a **local** PID lock and cannot see other hosts (`src/core/single-instance.ts`). Verified: with two instances connected, `/new` is picked up by **one** of them — and not consistently the same one (two runs, two different winners). Since each machine has its own `CONTROLLED_REPO_PATH` and its own approval rules, you cannot predict which machine ran your command or which repo it touched.

搬到新電腦的做法 / To move:

1. 舊機器先停掉（關掉程式，或 `schtasks /End /TN discord-copilot-sdk-default`）/ stop the old machine first
2. 新機器照 [`INSTALL.md`](../INSTALL.md) 安裝，填**同樣**的四個值 / install on the new machine with the **same** four values
3. 兩台都想留著 → 分別建立**各自的 Discord application**（各自的 token、各自的父頻道），不要共用 / keep both → give each its **own Discord application** (own token, own parent channel)

> `~/.discord-copilot-sdk/` 底下的狀態（可復原的 session、已記住的核准規則）是**每台機器各自的**，不會跟著同步。新機器會從乾淨狀態開始，這是刻意的：核准規則不該悄悄跟著跑到另一台機器上。
> State under `~/.discord-copilot-sdk/` (the resumable session, remembered approvals) is **per machine** and does not follow you. A new machine starts clean, deliberately: approval grants should not silently travel to another host.

---

## 9. 多個 session 同時進行 / Concurrent sessions

**可以並行。** 每個 `/new` 開的討論串都是獨立 session，預設每個都有**自己的 git worktree**（分支 `copilot/t-<threadId>`，放在 `~/.discord-copilot-sdk/worktrees/`），所以兩個 agent 同時改檔案不會互相覆蓋。
**Yes, they run in parallel.** Each `/new` thread is its own session, and by default each gets its **own git worktree** (branch `copilot/t-<threadId>`, under `~/.discord-copilot-sdk/worktrees/`), so two agents editing files at the same time cannot clobber each other.

| 指令 / Command | 用途 / Purpose |
| --- | --- |
| `/new` | 開一個新的並行 session（不會結束其他的）/ start another concurrent session (ends nothing) |
| `/sessions` | 列出目前有哪些、各自的狀態與分支 / list what's live, with state and branch |
| `/end` | 只結束**這個**討論串的 session / end **this** thread's session only |

上限同時 8 個 session。/ Up to 8 at once.

`/end` 只有在 git 回報**乾淨**時才會移除 worktree；有未提交的變更就保留並告訴你路徑 —— 沒提交的工作不該被順手刪掉。
`/end` removes the worktree **only when git reports it clean**; a dirty one is kept and its path reported — uncommitted work is not ours to discard.

### `SESSION_ISOLATION`

| 值 / Value | 行為 / Behaviour |
| --- | --- |
| （留空）/ unset | 自動：controlled repo 是 git repo → `worktree`，否則 `shared` / auto |
| `worktree` | 強制隔離。若不是 git repo 則**拒絕啟動**（而不是默默降級）/ force isolation; **refuses to start** if impossible |
| `shared` | 所有 session 共用同一個工作目錄 → **一次只有一個安全**，`/new` 會結束前一個（v1 行為）/ one shared checkout → only one is safe, `/new` ends the previous |

> agent 在 worktree 裡看到的是 repo 的完整內容（共用 git 物件），但只有自己的工作檔案。要把成果帶回主分支，就在該討論串裡請 agent commit，之後在主 repo `git merge copilot/t-<threadId>`。
> Inside a worktree the agent sees the whole repo (shared git objects) but only its own working files. To land the work, ask the agent to commit in that thread, then `git merge copilot/t-<threadId>` in the main repo.

同一個 session 內的並行（steer / `/queue`）見第 10 節。/ For concurrency *inside* one session see §10.

---

## 10. 一個 session 內的插隊與排隊 / Steering and queueing inside one session

- 回合進行中**直接送訊息** → 插入目前回合（steer）/ send a message **while a turn is running** → steers it
- `/queue message:…` → 排在目前回合之後執行 / queue a prompt to run after the current turn

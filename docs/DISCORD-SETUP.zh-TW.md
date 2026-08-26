# Discord Bot 設定指南

> [English](DISCORD-SETUP.md) · **繁體中文**

建立 bot、開啟正確的 intent、用正確的權限邀請它，並取得 `.env` 需要的四個 ID。

> 這份文件只處理 **Discord 那一側**。裝好之後請回到 [`INSTALL.zh-TW.md`](../INSTALL.zh-TW.md)。

最後你會得到 `.env` 的這四個值：

```env
DISCORD_BOT_TOKEN=          # 步驟 3
DISCORD_ALLOWED_USER_IDS=   # 步驟 5 — 你自己的 user ID
DISCORD_GUILD_ID=           # 步驟 5 — 伺服器 ID
DISCORD_PARENT_CHANNEL_ID=  # 步驟 5 — 種子預設值（首次啟動用）工作頻道 ID
```

---

## 0. 先建一個私人伺服器

Discord → 左側 **+** → **Create My Own** → **For me and my friends**。

在裡面建立一個**文字頻道**（例如 `#copilot`）當作**種子預設值**工作頻道——也就是它的首次啟動預設值。每個 session 都會是在某個已啟用工作頻道底下的討論串；`.env` 設定的是第一次啟動用的種子預設值。

> **為什麼要私人伺服器**：這個 bot 會以你的身分執行 shell 指令。任何看得到工作頻道的人都能看到 agent 的輸出（包含檔案內容）。輸入有 allow-list 保護，**輸出沒有**。

> 反過來也一樣值得管：邀請連結授予的 server-level 身分組可以讀取公開頻道，以及任何明確加入它的私密頻道。§4b 說明如何用私密頻道成員資格把 bot 限制在工作頻道；[`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md) 說明另一層 slash 指令顯示與 `/channel` 授權模型。

### 建議：連工作頻道本身也設為私密

私人**伺服器**能完全擋住陌生人，但一般公開頻道仍對伺服器所有成員可見，包含 bot。要讓 bot 的指令不要塞滿每個頻道的 `/` 選單，最主要且原生的做法是把每個**工作頻道**設為私密——這是 Discord 權限，不是這個 bot 自己的設定——並只把這個 bot 的 application（以及會用到它的人類）加為成員。完整模型與理由見 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md#3-主模型--私密工作頻道推薦的隱藏方式)。

**在同一個伺服器跑不只一個實例**（例如正式版 app 與獨立的測試版 app）：為每個實例建立**各自獨立的 Discord application**，各有自己的 bot user，並把每個 application 的 bot **只**加進它應該擁有的頻道。兩個 application 永遠不會共用成員資格，所以它們的指令不會在同一個頻道的選單裡重複出現——這正是 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md#6-來自第二個-app-的重複指令) 描述的「`/new` 重複」問題的修法。

---

## 1. 建立 Application 與 Bot

1. 前往 <https://discord.com/developers/applications> → **New Application** → 取名。這個名字會顯示在 Discord 上。
2. 左側 **Bot** 分頁。較新的介面會自動建立 bot；若沒有就按 **Add Bot**。

---

## 2. ⚠️ 開啟 Message Content Intent（最多人卡在這裡）

**Bot** 分頁 → **Privileged Gateway Intents** → 打開 **MESSAGE CONTENT INTENT** → **Save Changes**。

這個 bot 連線時會要求三個 intent（`src/app.ts`）：`Guilds`、`GuildMessages`、`MessageContent`。前兩個不需申請，**`MessageContent` 是特權 intent，必須在這裡手動打開**。

沒開會怎樣：bot 顯示在線、slash 指令也能用，但**你在討論串裡打字它完全沒反應** —— 因為它收得到訊息事件，卻讀不到內容。

> 其他兩個特權 intent（Presence、Server Members）**不需要**開。

### 順手關掉 Public Bot

同一個 **Bot** 分頁往下找 **PUBLIC BOT**，把它**關掉**。開著的話（這是預設值），任何知道你 Application ID 的人都能把**你的 bot** 邀進**他們自己的**伺服器。

這不是漏洞 —— `DISCORD_GUILD_ID` 是精確比對，別人的伺服器一律被拒，slash 指令也只註冊在你的伺服器。但沒有理由讓它被邀出去，而 Application ID 並不是秘密。

#### 會被這個錯誤擋住

```text
Private application cannot have a default authorization link.
Please check that the default authorization link is set to None in the installation tab.
```

Discord 不允許「私有 App」帶著公開安裝連結，所以**順序是反過來的**：

1. **Installation** 分頁 → **Install Link** → 選 `None` → **Save Changes**。
2. **Bot** 分頁 → **PUBLIC BOT** 關掉 → **再按一次 Save Changes**。

> 兩個分頁**各自**要存一次。下拉選單已經顯示 `None` 不代表存過了 —— Discord 的存檔是手動的，畫面上會浮出 **Save Changes** 提示條。

拿掉 Install Link **不會**影響已經在伺服器裡的 bot：slash 指令是 bot 啟動時自己用 API 註冊的，不是靠安裝流程註冊。日後若要重新邀請，用下面 §4 的網址即可。

### 選用：提前測試 Channel Obfuscation

Discord 正在推行一項破壞性的 Gateway 變更 —— 遮蔽 bot 看不到的頻道 —— **從 2026-11-16 起對所有 bot 強制**（完整機制見 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md#8-channel-obfuscation2026-08-12-變更2026-11-16-強制)）。你不需要做任何事來符合規定——bot 的程式碼本來就必須把任何名為 `"___hidden___"` 的頻道當成不透明——但你可以**現在**就讓這個 application 提前加入新的 Gateway 行為，先測試看看：**Bot** 分頁 → **Overview** → **Private Channel Obfuscation** 開關。這只影響 Gateway，是提前測試用的暫時開關；HTTP API 沒有對應的提前開關，一旦變更套用到你的 app，它就會直接開始省略被遮蔽的頻道。

---

## 3. 取得 Bot Token

**Bot** 分頁 → **Reset Token** → 複製。**只會顯示這一次。**

- 這是密碼等級的東西：拿到的人就能以這個 bot 的身分做任何事。
- **不要**提交進版控。`.env` 已在 `.gitignore`，安裝器也會拒絕寫入被追蹤的 `.env`。
- 外洩了就回這裡 **Reset Token**，舊的立刻失效。

---

## 4. 邀請 Bot 進伺服器

把下面網址中的 `YOUR_APP_ID` 換成 **General Information** 分頁的 **Application ID**。

依照主機平台選對邀請權限整數：

- **Windows 一般版：** `326417632256`
- **非 Windows 一般版：** `326417599488`
- **Windows 精簡版：** `309237763072`
- **非 Windows 精簡版：** `309237730304`

Windows 需要 `Attach Files`，因為只有 Windows 支援對外 Discord 檔案傳送。非 Windows 可以省略 `Attach Files`，因為該平台根本沒有對外送檔能力。

### Windows 一般版邀請網址

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=326417632256
```

在瀏覽器開啟 → 選你的伺服器 → **Authorize**。

### 這串數字是什麼

`permissions=326417632256` 就是下面這些權限。這個數字已向 Discord API 驗證過，會**原樣**解析成這一組、不多不少。

> **平台可用性：** 對外 Discord 檔案傳送僅支援 Windows。Linux、macOS 與其他主機仍能正常執行 session，但刻意不提供 `/file` 送檔或 `discord_send_file`，所以那些平台的 bot 不需要 **Attach Files**。

| 權限 | 為什麼需要 |
| --- | --- |
| View Channel | 看得到工作頻道。 |
| Send Messages | 一般 bot 慣例會給；這個 bot 自己的訊息**只發在討論串**。父頻道的回覆都是 ephemeral 互動回應。想再精簡的話這是第一個可以試著拿掉的。 |
| Attach Files | 在 Windows 上，`/file` 的刻意上傳，以及 agent 提議的 `discord_send_file` 經核准後送檔，都需要它；少了這個權限時，文字功能仍可用，但檔案傳送一定失敗。 |
| Embed Links | 權限卡片是 embed。 |
| Read Message History | 串流輸出時要編輯自己先前的訊息。 |
| Create Public Threads | `/new` 開討論串。 |
| Send Messages in Threads | **在討論串發言**。`Send Messages` 對討論串無效。 |
| Manage Threads | 只用在一件事：`/new` 失敗時清掉剛建的空討論串。 |

**已經邀請過 bot？** 如果你之前用的是舊的安裝連結，bot 身分組**不會**自動多出 `Attach Files`；你需要重新授權這個 application，或手動在工作頻道補上該權限。舊的 thread 文字功能仍可用，但 `/file` 與核准後的送檔在補權限前都會失敗。

### 非 Windows 一般版邀請網址

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=326417599488
```

這和一般版權限相同，只是拿掉 `Attach Files`，因為非 Windows 根本不能對外傳 Discord 檔案。

**想給更少權限**：

- **Windows 精簡版：** 拿掉 `Manage Threads`，改用 `permissions=309237763072`。
- **非 Windows 精簡版：** 從非 Windows 權限集合拿掉 `Manage Threads`，改用 `permissions=309237730304`。

除了對應平台的 `/new` 中途失敗時會留下一個空討論串要你自己刪之外，其餘功能照常。

> 改討論串名稱（自動命名與 `/rename`）**不需要** `Manage Threads` —— Discord 允許討論串的建立者改自己的討論串名稱，而討論串正是這個 bot 建的。

`scope=bot applications.commands` 兩個都要：`bot` 是 bot 本身，`applications.commands` 才能註冊 `/new`、`/stop` 這些指令。

---

## 4b. 🔒 限制 bot 能讀的範圍

上面的邀請連結把權限給在**身分組**上，而身分組權限是**整個伺服器通用**的 —— 意思是除非某個頻道自己的成員資格另有規定，否則 bot 看得到你**每一個**頻道，包括私人討論。對一個會把讀到的內容送進 Copilot 的工具來說，這值得收緊。

> **更正（依 2026-08-12 新事實更新）**：這份文件先前的版本主張，拒絕 bot 的 `View Channel` 只會限制 bot 能**讀**的內容，對指令是否出現在該頻道的 `/` 選單沒有影響。**這個說法是錯的，在此撤回。** 沒有 `View Channel` 存取權的頻道，bot 的指令也不會出現在那裡（[Discord Slash Commands FAQ](https://support-dev.discord.com/hc/en-us/articles/frequently-asked-questions)；[Command Permissions](https://support.discord.com/hc/en-us/articles/9349445088791-Command-Permissions-FAQ)）。也就是說，下面的私密頻道設定會同時給你**兩種**效果——讀取限制與指令可見度白名單——來自同一份頻道成員資格；證據等級，以及這如何對應到 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md#3-主模型--私密工作頻道推薦的隱藏方式) 描述的主要私密頻道模型，見 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md#4-更正一個過時的說法bot-的-view_channel-確實會影響指令可見度)。唯一仍然成立的是：Discord 仍可能把底層的 `INTERACTION_CREATE` payload 送到 bot 的後端（例如來自客戶端過時的快取指令清單），而且初始 interaction 回應不需要 `SEND_MESSAGES`（[Discord 文件](https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction)）——所以真正的安全邊界仍然是 bot 自己的 `/channel` 授權檢查，不是這個權限畫面。

### 先理解為什麼「不給權限」沒有用

大多數伺服器的 `@everyone` 身分組本身就帶著 **View Channels**，而 bot 也是成員，**一樣繼承它**。所以把 bot 身分組的權限清成 `0`，它照樣看得到所有沒有明確拒絕它的頻道——這正是為什麼下面的做法是針對**頻道成員資格**下手，而不是改 bot 的身分組。

自己確認一下：伺服器設定 → 身分組 → `@everyone` → 看 View Channels 是否開著。

| 設定位置 | 效果 |
| --- | --- |
| 身分組（伺服器層級）給 View Channels | 看得到**每一個**沒明確拒絕它的頻道。 |
| 頻道層級 **允許** View Channels | 只加開**那一個**頻道。 |
| 頻道層級 **拒絕** View Channels | **擋住**該頻道，優先於 `@everyone` 的伺服器層級允許。 |

Discord 的權限解析順序是：`@everyone` 伺服器層級 → 身分組伺服器層級 → `@everyone` 頻道覆寫 → **身分組頻道覆寫**。私密頻道自己對 `@everyone` 的頻道層級拒絕，正是真正擋住讀取的機制——下面的步驟就是靠這個。

### 正確的設定：把每個工作頻道都設為私密

| 放哪裡 | 給什麼 |
| --- | --- |
| Bot 的身分組 | **完全清空（`0`）** —— 包括不要 Administrator。 |
| 每個工作頻道 | 設為**私密**——拿掉 `@everyone` 的 View Channel（或一開始就建立為私密頻道）——然後**只**把 bot 的 application 和會用到它的人類加為明確成員，並給予下面那組工作權限。 |

這刻意是**成員資格制**，不是逐一列出「拒絕」的清單：你完全不需要跑去伺服器裡其他每一個頻道或分類設定什麼。一個 bot 從未被加入的頻道，本來就把它擋在外面——這和 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md#3-主模型--私密工作頻道推薦的隱藏方式) §3 說明指令可見度時給出的理由是同一個。

### 步驟

1. **每個工作頻道** → 設為私密（或直接建立為私密）→ 編輯頻道 → 權限 → 加入你的 bot application 與會用到它的人類 → 依主機平台打開對應的一組：
   - **Windows：** View Channels · Send Messages · Send Messages in Threads · Create Public Threads ·
     Create Private Threads · Manage Threads · Embed Links · Attach Files ·
     Read Message History · Add Reactions · Use External Emoji
     Windows 的整數是 `395137371200`。
   - **非 Windows：** 同一組但不含 `Attach Files`：View Channels · Send Messages ·
     Send Messages in Threads · Create Public Threads · Create Private Threads · Manage Threads ·
     Embed Links · Read Message History · Add Reactions · Use External Emoji
     非 Windows 的整數是 `395137338432`。
   這個範圍只限 bot 被明確加入的頻道，所以兩個平台各自的集合都可以比邀請權限稍微寬鬆。
2. 伺服器設定 → 身分組 → 你的 bot 身分組 → **關掉 Administrator**，其餘留空。該頁右上角的 **Clear permissions** 可以一次清空。這一步和上面的私密頻道設定都是由人類設定，兩者之間沒有先後順序的要求。

> **確認你改的是對的身分組。** 伺服器裡可能有多個整合身分組；編輯畫面的標題要顯示**你的 bot 名稱**。

> **這一步只能在網頁介面做。** bot 不能修改自己最高的身分組 —— Discord 的階層規則，`ADMINISTRATOR` 也繞不過（API 會回 `50013 Missing Permissions`）。

### 刻意不給的權限

| 權限 | 為什麼不給 |
| --- | --- |
| `Administrator` | 繞過**所有**頻道設定，上面做的隔離會全部失效。 |
| `Manage Messages` | 程式只刪**自己發的**訊息，那不需要這個權限；給了等於能刪你的訊息。 |
| `Manage Channels` / `Manage Roles` | 刻意**不給**——頻道／成員可見度一律由人類設定；bot 不需要、也絕不能修改自己的可見度權限。 |
| `Mention Everyone` | 完全用不到。 |

### 驗收

不要只看設定畫面 —— 實際測一次：

1. **正向**：在已啟用的工作頻道 `/new`，在討論串送一則訊息 → 應該正常回覆。
2. **反向**：在 bot 從未被加入的頻道 tag 或提到 bot → 它應該不會讀到那則訊息，也不會回應。這只能證明「訊息讀取」被限制；slash 指令顯示與 interaction 是否送達要依 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md) 另外驗證。

Discord 左側頻道列表沒有真正的「以 bot 視角檢視」，但成員清單是有用訊號：bot 應該只出現在工作頻道的成員清單裡。

---

## 4c. 指令權限預設值：`default_member_permissions="0"`

這個 bot 註冊的每個指令都帶著 `default_member_permissions="0"`。依 Discord 對這個欄位的語意，這代表**除非持有 guild 的 Administrator 權限，或在 Server Settings → Integrations → 該 app → Command permissions 裡有明確的 per-user／per-role 覆寫，否則 guild 裡預設沒有人能使用這個指令**（[Discord 文件](https://docs.discord.com/developers/interactions/application-commands#permissions)）。

這是刻意的：搭配上面的私密頻道模型，即使某個 guild 成員恰好看得到某個工作頻道，光靠「看得到」也不足以讓他呼叫指令。

**要注意的地方**：bot 自己的 `isAuthorized` allow-list（`DISCORD_ALLOWED_USER_IDS`）從來不要求其中的使用者是 guild Administrator——那是另一個獨立的授權平面（見 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md)）。如果你 allow-list 裡有人**不是** guild Administrator，`default_member_permissions="0"` 會讓他即使在看得到的工作頻道也完全無法呼叫任何指令，直到在 Integrations 為他加上覆寫為止。bot 在啟動時會印出警告，點名遇到這種情況的 allow-listed 使用者，並給出確切的逃生路徑：到 Integrations → Command permissions，為該使用者（或他所屬的身分組）加上明確允許。

guild 的**擁有者**會被視為隱含滿足這項檢查（擁有者本來就有等同 Administrator 的權限），所以一般的單一擁有者設定不會觸發這個警告。

---

## 5. 取得四個 ID

先開啟開發者模式：**User Settings → Advanced → Developer Mode**。

| 要填的欄位 | 怎麼拿 |
| --- | --- |
| `DISCORD_GUILD_ID` | 右鍵伺服器圖示 → **Copy Server ID**。 |
| `DISCORD_PARENT_CHANNEL_ID` | 右鍵**種子預設值**文字頻道 → **Copy Channel ID**。這是 bot 第一次啟動時自動被授權的頻道（它的首次啟動預設值）——不是 bot 唯一能用的頻道，也不會在不再需要時永遠不能被 `/channel disable`。 |
| `DISCORD_ALLOWED_USER_IDS` | 右鍵**你自己的名字** → **Copy User ID**。 |
| `DISCORD_BOT_TOKEN` | 來自 §3。 |

- 種子預設值頻道必須是**文字頻道**（不能是分類、論壇、公告頻道、語音頻道或討論串）；bot 啟動時會檢查。
- `DISCORD_ALLOWED_USER_IDS` 是逗號分隔，但 v1 建議**只放你自己**。清單外的人即使在已啟用頻道也無法下指令。

### 之後想換父頻道

bot 現在支援多個工作頻道。`DISCORD_PARENT_CHANNEL_ID` 只是一個**種子預設值**：這個 bot 實例第一次啟動時會自動被授權的頻道，讓開箱即用時至少有一個可用頻道。第一次啟動之後，它就會被寫進登錄檔，變成和用 `/channel enable` 加入的頻道完全一樣的普通已啟用紀錄——不是永久、不可停用的特例——之後再改 `.env` 對已持久化的授權**沒有任何效果**，因為登錄檔一旦寫入就是唯一權威來源。其他（或替換用的）工作頻道在執行中用 `/channel enable`／`/channel disable` 管理；見 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md)。

在既有安裝上把種子預設值換成別的工作頻道：

1. 把新頻道設為私密，加入 bot 與預定的人類成員，並依 §4b 給完整工作權限。
2. **趁舊頻道仍是 enabled**，從舊頻道執行 `/channel enable channel:<新頻道-id>`（或在新頻道執行 `/channel enable`），再用 `/channel list` 驗證新項目。
3. `/end` 結束所有仍指向舊頻道的 sessions，對舊頻道執行 `/channel disable`，最後才從舊頻道的成員／覆寫中移除 bot。

這時候改 `.env` 的 `DISCORD_PARENT_CHANNEL_ID` 只對**全新安裝**（從未寫過登錄檔）有意義——對已經啟動過一次的安裝，它不會回溯重新種子或重新授權任何東西。被停用波及的 session 不會自己消失：bot 下次啟動會列出這些孤兒紀錄，用 `/end thread:<id>` 清掉，順便回收 worktree。

---

## 6. 驗收

回到專案資料夾照 [`INSTALL.zh-TW.md`](../INSTALL.zh-TW.md) 裝好、啟動後：

1. bot 在成員清單顯示**在線**。
2. 在種子預設值頻道打 `/` → 看得到 `/new`、`/stop`、`/usage` 等指令。
3. `/channel list` → 種子預設值應顯示為已啟用且可見，而且沒有非預期的可見度漂移。
4. `/new` → 開出一個新討論串。
5. 在討論串打「hello」→ **有回應**。沒回應代表 §2 的 intent 沒開。

### 驗證 §4b 的私密頻道設定

設定畫面看起來正確**不等於**真的生效 —— Discord 的權限是四層疊加運算出來的。實際驗證：

1. **正向**：在已啟用工作頻道 `/new` → 開討論串 → 打字 → 有回應（證明私密頻道成員資格有效）。
2. **讀取限制反向測試**：到 bot 從未被加入的頻道提到 bot → 它應該不會讀到，也不會回應（證明限制有效）。
3. **指令存取反向測試**：到沒有啟用的頻道打 `/`，應該看不到指令。如果仍然看得到，代表缺了 Discord 平面的整合設定；見 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md)。

反向測試才是重點。只驗第一條的話，你證明的是「能用」，不是「被關住」。

---

## 7. 疑難排解

| 症狀 | 原因 |
| --- | --- |
| bot 在線，但討論串裡打字沒反應 | **Message Content Intent 沒開**（§2）。 |
| 打 `/` 看不到指令 | 邀請時少了 `applications.commands` scope → 用 §4 的網址重新邀請一次。如果指令出現在錯的頻道，請照 [`CHANNEL-ACCESS.zh-TW.md`](CHANNEL-ACCESS.zh-TW.md) 設定 Server Settings → Integrations。 |
| `/new` 說 Missing Permissions | 少 `Create Public Threads`，或頻道權限覆寫擋掉了 bot。 |
| 討論串開了但 bot 不說話 | 少 `Send Messages in Threads`（`Send Messages` 對討論串無效）。 |
| 指令回「Not authorized」 | `DISCORD_ALLOWED_USER_IDS` 不是你的 user ID。 |
| 指令只在某些伺服器出現 | 指令是註冊到 `DISCORD_GUILD_ID` 那個伺服器的。 |
| 收緊權限後 bot 整個消失了 | 依 §4b 把 bot 重新加入每個工作頻道並授予 View Channel。**不要**重新開啟 Administrator。 |
| 改了 `DISCORD_PARENT_CHANNEL_ID`，但 bot 沒有移到新頻道 | 第一次啟動後這是正常行為：durable channel registry 才是權威來源。先把 bot 加進新的私密頻道並 `/channel enable`；結束舊頻道 sessions 後再 `/channel disable` 舊項目。 |

---

## 8. 在第二台電腦安裝

**不要**兩台同時用同一個 token 跑。

Bot 靠一個**本機** PID 鎖來避免重複啟動，它看不到別台機器（`src/core/single-instance.ts`）。實測：兩個實例同時連線時，`/new` 會被**其中一個**接走 —— 而且不是固定的哪一個（測兩次分別由不同實例處理）。由於每台機器有自己的 `REPOS_ROOT` 和自己的核准規則，你會無法預期指令到底跑在哪台機器、動到哪個 repo。

搬到新電腦的做法：

1. 舊機器先停掉：關掉程式，或執行 `schtasks /End /TN discord-copilot-sdk-default`。
2. 新機器照 [`INSTALL.zh-TW.md`](../INSTALL.zh-TW.md) 安裝，填**同樣**的四個值。
3. 兩台都想留著 → 分別建立**各自的 Discord application**：各自的 token、各自的種子預設值工作頻道，不要共用。

> `~/.discord-copilot-sdk/` 底下的狀態（可復原的 session、頻道登錄檔、已記住的核准規則）是**每台機器各自的**，不會跟著同步。新機器會從乾淨狀態開始，這是刻意的：核准規則與頻道授權不該悄悄跟著跑到另一台機器上。

---

## 9. 多個 session 同時進行

**可以並行。** 每個 `/new` 開的討論串都是獨立 session，預設每個都有**自己的 git worktree**（分支 `copilot/t-<threadId>`，放在 `~/.discord-copilot-sdk-worktrees/`），所以兩個 agent 同時改檔案不會互相覆蓋。

> 這是防止**意外**互相覆蓋，不是沙箱。lab 模式下工具以你的 OS 使用者身分執行且沒有隔離，被刻意操控的 agent 仍可用路徑存取別的 worktree。

| 指令 | 用途 |
| --- | --- |
| `/new` | 開一個新的並行 session（不會結束其他的）。 |
| `/sessions` | 列出進行中的 session，並把殘留記錄分成「可清除」與「重啟後會再試」兩類。 |
| `/end` | 只結束**這個**討論串的 session；沒有進行中的 session 時，清除該討論串的殘留記錄與 worktree。 |
| `/end thread:<id>` | 從已啟用工作頻道清除討論串已刪除的殘留記錄。 |

上限同時 8 個 session。

`/end` 只有在 git 回報**乾淨**時才會移除 worktree。被 `.gitignore` 忽略的檔案也算「有東西」；有任何本地內容就保留並告訴你路徑。`/diff` 顯示的是**這個討論串自己的** worktree。

### `/repo` — 每個討論串綁哪個 repo、怎麼開發

| 指令 | 作用 |
| --- | --- |
| `/repo show` | 顯示這個討論串綁的 repo、模式、分支與**完整工作目錄**。 |
| `/repo list` | 列出 `REPOS_ROOT` 底下可用的 repo，並標出被 local 模式佔用的。 |
| `/repo set <name>` | 改綁這個討論串；輸入時可搜尋。 |
| `/repo dev <worktree\|local>` | 換開發模式。 |
| `/repo clone <source> [name]` | clone 進 `REPOS_ROOT` 再綁定。 |
| `/repo new <name>` | 在 `REPOS_ROOT` 建空 repo 再綁定。 |

**每個新 session 都有自己的 worktree。** `local`（agent 直接改 repo 本體）只能在該討論串用 `/repo dev local` 明確開啟；**沒有**任何設定鍵能把它變成預設，因為那等於讓之後每個討論串都在沒人決定的情況下直接動你的工作區。

同一個 repo 同時只能有一個 **local** session（限**同一個 bot 行程**內；刻意跑兩個共用 `REPOS_ROOT` 的實例時互相看不到）。兩個 agent 改同一份 checkout 會互相靜默覆蓋，其中一個 `git checkout` 就會毀掉另一個未提交的工作 —— 所以第二個討論串會被直接拒絕，並告訴你是誰佔用中。worktree 模式沒有這個限制。

改綁會建立**新的** Copilot session（SDK 只在建立時接受工作目錄），因此**對話歷史會消失**；已經跑過回合的討論串會先要求按鈕確認。回合進行中一律拒絕改綁；目前 worktree 有未提交、未追蹤或被忽略的內容時也拒絕 —— 改綁後就沒有任何記錄指向那棵樹了。

`/repo clone` 只走 `https`/`ssh`，預設只允許 `github.com`（`REPO_CLONE_HOST_POLICY=allowlist` 可指定其他主機），且一律拒絕 internal、loopback、metadata 位址。git 以 argv 陣列啟動（永不經 shell），關閉 `ext::`、`file::`、credential helper，並忽略你的 global git 與 ssh 設定 —— `url.<base>.insteadOf` 會改寫網址，ssh 的 `ProxyCommand` 會執行程式。刻意不提供「任意公開主機」選項：主機名稱無法證明 DNS 會指向哪裡。

> agent 在 worktree 裡看到的是 repo 的完整內容（共用 git 物件），但只有自己的工作檔案。要把成果帶回主分支，就在該討論串裡請 agent commit，之後在主 repo `git merge copilot/t-<threadId>`。

同一個 session 內的並行（steer / `/queue`）見 §10。

---

## 10. 一個 session 內的插隊與排隊

- 回合進行中**直接送訊息** → 插入目前回合（steer）。
- `/queue message:…` → 排在目前回合之後執行。

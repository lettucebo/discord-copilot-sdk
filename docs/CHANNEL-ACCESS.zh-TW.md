# 頻道存取

> [English](CHANNEL-ACCESS.md) · **繁體中文**

這份文件是權威模型：bot 的指令在哪裡出現、bot 在哪裡被允許動作，以及為什麼這是各自獨立的決策。

---

## 1. 三個平面

| 平面 | 由誰設定 | 控制什麼 | 是安全邊界嗎？ |
| --- | --- | --- | --- |
| Bot 授權 | 擁有者，用 `/channel` | bot 是否**採取動作** | **是** —— 這才是真正的邊界 |
| Bot 可見度（頻道成員資格） | 伺服器管理員，把工作頻道設為**私密**並只把這個 bot app 加進去 | bot 是否收得到該頻道內容，**以及**它的指令是否出現在那裡（§3） | 隱藏 bot 的**主要機制** |
| Discord 指令權限 | 伺服器管理員，在 Server Settings → Integrations | 在可見度平面之上，per-app 的指令可見度覆寫 | 次要／手動；見 §5 |

`/channel` 是唯一的 bot 端授權介面（§2）。§3–§5 討論的是 bot 的 slash 指令**出現在哪裡**、gateway 事件送不送得到 bot —— 這是 Discord 平台層級的問題，不是授權，但正是這一層真正阻止伺服器裡其他人發現這個 bot 的存在。

Interaction 會不受頻道收發權限影響送到 bot 的後端，而且初始 interaction 回應不需要 `SEND_MESSAGES`（[來源](https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction)）。這就是為什麼真正的授權邊界是 `/channel`，而不是 Discord 可見度：只要指令在任何不該出現的地方仍然可觸及，bot 就必須仍然拒絕它。如果 bot 對禁止的 interaction 完全不回答，Discord 會在 3 秒後顯示 "The application did not respond"；所以 ephemeral refusal 是最安靜且合法的回應（[來源](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback)）。

---

## 2. Bot 平面 — `/channel`（授權邊界）

指令介面：

- `/channel enable [channel:<id or #mention>]` — 啟用目前頻道，或指定的頻道。`channel:` 是**字串** option，所以也接受 raw ID，風格和既有 `/end thread:<id>` 一樣。
- `/channel disable [channel:<id or #mention>]`
- `/channel list`

規則：

- 只有在 `DISCORD_ALLOWED_USER_IDS` 裡的使用者可以執行 `/channel`。
- 目標必須是設定 guild 裡一般的**文字頻道**。Threads、forum channels、announcement channels 和 voice channels 都會被拒絕。
- `DISCORD_PARENT_CHANNEL_ID` 是**種子預設值**：bot 第一次啟動時自動被授權的值，讓開箱即用時至少有一個可用頻道。它只會匯入登錄檔一次；第一次啟動之後，它就是一筆和其他一樣的普通已啟用頻道紀錄——一旦沒有 session 還需要它，就可以像用 `/channel enable` 加入的頻道一樣被停用。登錄檔建立之後，再修改 `.env` 裡的 `DISCORD_PARENT_CHANNEL_ID` **不會**改變授權。（`first-run default`／首次啟動預設值是操作者文件對同一個種子預設值使用的描述性同義詞。）
- `enable` 會回報 bot 在該頻道缺少的權限：View Channel、Send Messages、Create Public Threads、Send Messages in Threads、Embed Links、Read Message History；但仍然會啟用，因為權限不是授權。Manage Threads 只用於 `/new` 失敗後的清理，是選用權限，這個檢查不會要求或回報它。
- 對 bot 目前**看不到**的頻道執行 `enable` 會被拒絕，並給出精確指引：先依 §3 把 bot 加進那個私密頻道，再重新執行 `/channel enable`。授權一個 bot 看不到的頻道，只會造成一筆無法真正動作的已啟用紀錄。
- `disable` 在該頻道仍有進行中的 session，或儲存的 `active`／`creating` 記錄時會**拒絕**。請先用 `/end` 結束它們。這是刻意的：bot 不會為了整理而摧毀工作。
- `/channel list` 顯示 **bot 授權**，並會與 bot 目前實際看得到的頻道交叉比對，讓漂移狀態（已授權但看不見、看得見但未授權）被揭露而不是被掩蓋。

登錄檔位於 `~/.discord-copilot-sdk/<instance>.channels.json`。如果登錄檔損毀，或屬於外部 guild，bot 會**拒絕啟動**，而不是靜默退回種子預設值。靜默 fallback 會把所有其他頻道的 session 標成 blocked，而且不可逆。解除安裝器會把這份登錄檔和其他狀態目錄一起移除。

---

## 3. 主模型 — 私密工作頻道（推薦的隱藏方式）

把工作頻道設為**私密**、只把這個 bot 的 application 加進去，就是 Discord 原生的白名單：不是頻道成員的 bot 收不到該頻道的 gateway 事件，而且——依 §4 更正過的結論——它的 slash 指令也不會出現在那個頻道的 `/` 選單。不需要任何 Integrations 設定就能得到這個效果；這是 Discord 一般頻道權限自然而然的結果。

**每個工作頻道的設定步驟：**

1. 建立（或編輯）頻道 → 設為**私密**（移除 `@everyone` 的 View Channel，或一開始就建成私密頻道）。
2. 編輯頻道 → 權限 → **只加入這個 bot 的 application**（以及該用它的人類），給予 View Channel 加上 [`DISCORD-SETUP.zh-TW.md`](DISCORD-SETUP.zh-TW.md#4b--限制-bot-能讀的範圍) 裡的權限組合。
3. 在該頻道執行 `/channel enable`（或從已啟用的頻道執行 `/channel enable channel:<id>`）。

**同一伺服器多個 bot 實例**（例如正式版與測試版）：每個實例建立各自獨立的 Discord application，並把每個 application 的 bot **只**加進它應該擁有的頻道。因為每個 app 是不同的成員集合，正式版的指令永遠不會出現在測試頻道，反之亦然——這取代了逐一在 Integrations 手動管理各個 app（§6）。

**把頻道移出白名單**：先 `/end` 結束該頻道的 sessions → `/channel disable` → 從頻道移除 bot 的成員資格／覆寫。請先做 disable、再撤銷 Discord 層級的存取，否則如果那正是唯一還能管理授權的頻道，`/channel disable` 本身可能就變得無法觸及。

> 如果 bot 意外失去它自己在某頻道的 View Channel（有人改了權限、身分組變動等），對該頻道的 API 呼叫——包括綁定在它上面的既有 session——都會得到 `50001 Missing Access`。依 [ADR-0002](adr/0002-missing-access-is-retryable.md)，這個特定失敗被視為**可重試**，不是終態：復原 bot 的存取權後，受影響的 session 就會恢復，這和 §7 描述的結構性不符不同。恢復**不需要重啟**——執行中的 bot 會定期重掃它的 `thread-no-access` 紀錄（第一次 15 秒後，之後逐步退避到最多每 5 分鐘一次），一旦該討論串重新判定為可存取就復原它；重啟只是把同一個檢查立刻跑一次而已。權限恢復不保證會針對「bot 原本看不到的討論串」送出任何 gateway 事件，所以讓這個承諾成真的是這個週期性掃描，而不是事件。`/sessions` 會把這類 `thread-no-access` 紀錄列在專屬的區段——存取權恢復後會自動重試，但擁有者也可以刻意放棄它、用 `/end thread:<id>` 明確清除。

---

## 4. 更正一個過時的說法：bot 的 `VIEW_CHANNEL` **確實**會影響指令可見度

這份文件（與 `DISCORD-SETUP.zh-TW.md`）先前的版本主張：拒絕 bot 的 `VIEW_CHANNEL` 只會限制它能**讀**的內容，對指令是否出現在該頻道的 `/` 選單沒有影響。**這個說法是錯的，在此撤回。** 如果 bot 不是某頻道的成員（沒有 `VIEW_CHANNEL`），它的 slash 指令**不會**出現在那個頻道給任何人看的 `/` 選單裡（[Discord Slash Commands FAQ](https://support-dev.discord.com/hc/en-us/articles/frequently-asked-questions)；[Command Permissions](https://support.discord.com/hc/en-us/articles/9349445088791-Command-Permissions-FAQ)；[discord-api-docs discussion #4959](https://github.com/discord/discord-api-docs/discussions/4959)）。這正是 §3 主模型所依賴的機制。

**證據等級**：以上來源是一致的二手文件（支援文章與維護中的社群討論串），不是第一方 API 參考文件的明文陳述。§9 的正反向驗收才是真正在你的伺服器上把這件事收尾的步驟——不要跳過。如果它被實測推翻，§3 的主模型在讀取限制與「@ 訊息不會到達 bot」兩點上仍然成立，只有指令選單這部分需要退回 §5 的 Integrations 覆寫。

透過 Integrations 的指令權限覆寫（§5）是疊加在這之上的另一層：它可以進一步限制一個「bot 看得到該頻道」情境下的可見度，但**不能**讓 bot 的指令出現在它看不到的頻道。

---

## 5. 次要／未來選項 — Discord Integrations 指令權限

當你需要比「bot 是不是該頻道成員」更細緻的可見度控制時，才用 Server Settings → Integrations → 該 app → Command permissions——例如在 bot 已經共享的頻道裡，限制**哪些 allow-listed 的人類**可以呼叫指令，或是在 §3 之上疊加多一層拒絕做縱深防禦。先對 **All Channels** 拒絕這個 app，再只允許工作頻道。

**為什麼這無法由 bot 自動化：** 修改 Application Command Permissions 需要一個持有該 guild Manage Guild 與 Manage Roles 權限之人類使用者的 OAuth2 bearer token，去呼叫 `applications.commands.permissions.update`（[來源](https://docs.discord.com/developers/interactions/application-commands#permissions)）。bot 自己的 token 沒有對應的 scope，在任何設定下都無法呼叫這個 endpoint——沒有 service-account 或 bot-token 能走這條路，所以這一步永遠是手動、由人類、逐伺服器執行的動作，不是本專案未來打算補上的缺口。這也是為什麼這裡把它記為**次要**選項：§3 不需要任何人類 OAuth 授權、也不需要逐 app 手動維護就能持續運作。

這個設定會跨 bot 重啟保留。bot 每次啟動都會對 guild commands 做 bulk-`PUT`；Discord 的 bulk overwrite 會用 command **name** 比對既有指令，名字不變時會保留 command ID（[來源](https://docs.discord.com/developers/interactions/application-commands#bulk-overwrite-guild-application-commands-json-params)）。因為名字不變的指令不是新建，也不會消耗每個 guild 每天 200 次 create 的額度（[來源](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)）。

指令註冊也會對每個指令設定 `default_member_permissions="0"`，意思是除非持有 Administrator 或在這裡有明確的 per-user／per-role 覆寫，否則 guild 裡沒有人預設能呼叫它（[來源](https://docs.discord.com/developers/interactions/application-commands#permissions)）。如果 `DISCORD_ALLOWED_USER_IDS` 裡有人不是 guild 管理員，就需要在這裡先加上覆寫才能使用任何指令——啟動時的對應警告見 [`DISCORD-SETUP.zh-TW.md`](DISCORD-SETUP.zh-TW.md)。

---

## 6. 來自第二個 app 的重複指令

如果兩個 Discord applications（例如 `DisPilot` 與 `DisPilot-Test`）都能看到同一個頻道，兩者都會註冊自己的 `/new`、`/diff`、`/context` 等指令。選單會分別列出它們，並標上各自的 app。

多個 app 可以合法共用 command names，而平台沒有任何方式讓其中一個從另一邊壓掉對方（[來源](https://docs.discord.com/developers/interactions/application-commands#registering-a-command)）。在 §3 的私密頻道模型下，正確修法是結構性的：讓每個 app 擁有自己專屬的頻道，讓它們的成員集合永不重疊。用 Integrations（§5）把某個 app 限制在自己的頻道也可行，但那是手動備案，不是預設做法。

---

## 7. `blocked` 是終態 —— 以及它和可重試 no-access 的差別

如果手動編輯或從外部還原的登錄檔不再包含某個 parent channel，但仍有 session records 指向它，這些 records 會在下次啟動時被標成 `blocked`。重新啟用該頻道**不會**復活它們。這是一種**結構性**不符：紀錄的授權已經和現實對不上，而且無法安全判斷重新啟用代表「復原舊的綁定」還是「巧合地重用了同一個 id 給別的東西」。registry 建立後再改 `DISCORD_PARENT_CHANNEL_ID` 不會造成這種情況；持久化登錄檔仍是權威來源。

這和 bot 單純失去自己的頻道存取權（§3 的提示、[ADR-0002](adr/0002-missing-access-is-retryable.md)）不同：那是 `no-access`，是可重試的，因為授權紀錄或 thread／parent 關係本身都沒變——只有 bot 自己的可見度變了。

用 `/end thread:<id>` 清除真正終態的 `blocked` 紀錄；git 證明 worktree 乾淨時，也會一併回收 worktree。

---

## 8. Channel Obfuscation（2026-08-12 變更，2026-11-16 強制）

Discord 公告了一項破壞性變更，改變 bot 看不到的頻道如何被表示，現在生效，且**從 2026-11-16 起對所有 bot 強制**（[change log](https://docs.discord.com/developers/change-log)）：

- bot 沒有 `VIEW_CHANNEL` 存取權的頻道仍然會**透過 Gateway 派送**，但會被遮蔽：`name` 變成字面字串 `"___hidden___"`，其他敏感欄位被清空，`flags` 會帶有 `CHANNEL_OBFUSCATED` 這個 bit（`1 << 17`），`permission_overwrites` 只剩一條「對 `@everyone` 拒絕 `VIEW_CHANNEL`」的紀錄。
- **HTTP 省略**：`GET /guilds/{guild.id}/channels` 及類似的 REST 列表呼叫會**整個省略這些頻道**，而不是回傳一個遮蔽後的替身。不要把「在 REST 頻道列表裡消失」誤判成「頻道被刪除」。
- 一旦 bot 取得存取權，Gateway 會立刻送出帶有真實、已解除遮蔽資料的 `CHANNEL_UPDATE`。
- **Interaction payload 例外**：這個遮蔽**不適用**於 interaction payload（`INTERACTION_CREATE`）裡帶的頻道資料。使用者呼叫指令時，Discord 仍然會把真實的頻道參照交給 bot 讓它能回應——這是為了回應觸發該次 interaction 而開的窄例外，不是一般性的讀取授權。
- 你可以**現在就**在強制日期之前測試 Gateway 端行為：Developer Portal → 你的 application → **Bot** 分頁 → **Private Channel Obfuscation**（或 IDENTIFY 的 `capabilities` bit `1 << 15`）。HTTP 端沒有對應的提前開關；一旦你的 app 生效，它就會直接開始省略那些頻道。

**對這個 bot 的實際影響**：任何讀取頻道 `name`，或列舉 `guild.channels` 的程式碼路徑，都不能把 `"___hidden___"`（或快取住的遮蔽前舊名字）當成真實名稱顯示，也不能只因為某頻道從 REST 列表呼叫中消失，就斷定它被刪除了。

---

## 9. 驗收 — 正反兩邊都要做

- **正向**：在 bot 是成員且已啟用的頻道，`/` 會列出指令，`/new` 會開討論串，並且在討論串打字會收到回覆。
- **反向（可見度）**：在一個 bot 從未被加入的私密頻道，`/` **不應該**列出指令。使用者仍然可以*打出* bot 的 `@` 提及——Discord 不會阻止這段文字——但因為 bot 不是該頻道的成員，它永遠不會收到、讀取或回應那則訊息。這才是真正在你的伺服器／客戶端版本上確認 §4 更正結論的測試——不要省略它。
- **反向（授權）**：在一個 bot **看得到**、但從未 `/channel enable` 的頻道，指令可能仍會出現在選單裡，但呼叫它必須只得到 ephemeral refusal —— bot 不會做任何事。這才證明真正的邊界是 `/channel`（§2），不是可見度。
- **遮蔽回歸檢查**：把 bot 從某工作頻道移除，確認該 app 的 `GET /guilds/{guild.id}/channels` 不再列出它，且這個 bot 自己的日誌／狀態裡任何快取的頻道清單顯示的是替身而不是過時的真實名稱；把 bot 加回去後確認頻道以真實資料重新出現。

**只有反向測試才能證明你真正想要的東西。**

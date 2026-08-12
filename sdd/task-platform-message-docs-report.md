# 平台訊息與文件修正報告

## 範圍
- 修正 YOLO 開啟警告與啟用後 notice，讓內容依平台是否支援 outbound Discord file delivery 而變。
- 更新 Discord setup 英文/繁中雙文件，明確列出 Windows 與非 Windows 的 normal/lean invite masks。

## 證據與來源
- `src/app.ts`：`yoloOnWarning(repoSkillsLoaded, fileDeliveryAvailable)` 改由 `fileDeliveryAvailable()` 決定檔案傳送提示內容。
- `test/discord-routing.test.ts`：新增 Windows / 非 Windows helper 行為覆蓋。
- `test/app-channels.test.ts`：新增 `/yolo mode:on` 在非 Windows 下的 warning 與 live notice 測試。
- `docs/DISCORD-SETUP.md`、`docs/DISCORD-SETUP.zh-TW.md`：加入四組 invite masks 與 Attach Files 差異說明。
- `test/file-delivery-docs.test.ts`：新增雙語文件 invite mask 驗證。

## TDD 記錄
1. 先新增 helper 與 cmdYolo 的 Windows/非 Windows 測試。
2. 執行 `npx vitest run test/discord-routing.test.ts test/app-channels.test.ts`，確認新測試失敗，失敗原因是現行訊息仍無條件宣稱 `discord_send_file` fast-deny 與 `/file` fallback。
3. 實作平台感知 helper 與 cmdYolo notice。
4. 重新執行相同測試，通過。
5. 新增 docs 測試後先失敗，再修正文案與斷言，最後通過。

## 驗證
- `npx vitest run test/discord-routing.test.ts test/app-channels.test.ts test/file-delivery-docs.test.ts`
- `npm run typecheck`
- `npm test`

## Council / Rubber Duck Review
- 一致性：Windows 仍保留 truthful fast-deny + `/file` fallback；非 Windows 改為明說 outbound delivery unavailable，未宣稱不存在的 fallback。
- 安全性：未更動任何 approval / deny 行為；只改警告與文件敘述。
- 文件對齊：英文與繁中 twins 都含四組指定權限整數，且解釋 Attach Files 僅 Windows 需要。

## 結果
- 需求兩項皆已完成。
- 未修改無關設定、lockfile 或其他文件。

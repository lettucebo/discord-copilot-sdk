# CI 疑難排解

> [English](CI-TROUBLESHOOTING.md) · **繁體中文**

本文件記錄此 repository 在 GitHub Actions matrix 中反覆出現的失敗，以及 push 前應執行的檢查。

## 1. 在本機重現 CI

CI 會在 Ubuntu 與 Windows 上測試 Node 20.19、22.12。Vitest 刻意序列化，因為數個 suite 會建立真正的 Git repository 與 worktree。

```bash
npm install --no-audit --no-fund
npm run typecheck
npm test
```

本專案沒有 TypeScript lint 指令。`npm run build` 不會 typecheck `test/`；請使用 `npm run typecheck`。缺少 `node_modules` 時會出現大量誤導性的「Cannot find module」，因此要先安裝 dependencies。

Script-check job 也會執行：

```bash
for f in install.sh get.sh update.sh run-bot.sh stop-bot.sh uninstall.sh; do bash -n "$f"; done
for f in scripts/setup.mjs scripts/run.mjs scripts/update.mjs scripts/uninstall.mjs scripts/release.mjs scripts/lib/*.mjs; do node --check "$f"; done
```

若本機沒有 `pwsh`，PowerShell parse 結果以 CI 為準。

## 2. 常見失敗

### `update-integration` 出現 `Hook timed out` 或 `EPERM ... git.exe`

Windows 可能在 child exit 後短暫鎖住複製的 `git.exe`。Cleanup 必須使用有界重試，Vitest cleanup-hook timeout 也必須涵蓋每個複製 wrapper 的重試 budget。不要用無限重試或忽略 cleanup error 來掩蓋洩漏的 process。

### Path assertion 只在 Windows 失敗

Git Bash path、`RUNNER~1` 之類的 Windows short name、handle canonical path、drive-letter 大小寫與反斜線 escaping，可能是同一位置的不同表示法。應從已驗證的 handle 或 Node path API 推導 expected value；不要寫死 runner path，也不要直接比較未正規化的顯示字串。

### Windows 的 shell bootstrap 顯示 `No such file or directory`

Node 產生的 path 不一定能直接給 Git Bash 使用。測試呼叫 Bash 時，fixture path 應留在 checkout 內，並經過 shipped wrapper 使用的相同轉換邊界。

### Fixture 的 `git commit` 回報未知或空白 identity

Hosted runner 不保證有可用的 global Git identity。每個會 commit 的暫存 repository 都必須設定 local `user.name`、`user.email`，需要時也要設 `commit.gpgsign=false`。

### 「npm 不存在」測試反而執行真實 npm，或找不到預期 command

Windows 解析 `.cmd` launcher 的方式與 POSIX executable 不同。Fixture 應明確建立 `PATH`，必要時同時保留 `PATH` 與 `Path`，並驗證受保護的 setup log，不要依賴開發機的 global tools。

### Installer/runtime configuration contract 失敗

`src/config.ts`、`scripts/lib/validate.mjs` 與 `test/config-contract.test.ts` 是同一份 contract。修改時必須同步更新 runtime schema、installer validation/managed keys 與共用 acceptance corpus；optional 空值在兩側也必須具有相同意義。

### Script check 只在單一平台失敗

所有 shipped `.sh` 都必須有 shebang、LF line ending 與 executable Git mode。面向使用者的 `.ps1` 必須符合 repository 的 encoding/line-ending contract，且要能在保留 UTF-8 BOM、再 trim BOM 後 parse，以符合 `Invoke-RestMethod` 的行為。

### Log 有 warning，但測試仍通過

部分 fail-closed 測試會刻意觸發 persistence、permission、reconciliation 或 resume error，並寫到 stderr。請以 Vitest summary 與 exit code 判斷；不要為了消除預期 warning 而靜音受測行為。

## 3. 為什麼 session 的第一次 CI 常失敗

這不是 Copilot session 啟動錯誤。Branch push 會啟動完整的四組 OS/Node matrix，但開發通常只在單一 OS 進行。第一次 run 因而會揭露本機 Ubuntu validation 無法涵蓋的 Windows process lock、path 表示、shell 或 hosted-runner 假設。每次修正都會產生新 commit 並再觸發一次 CI，所以歷史看起來像「每個 session 都先失敗，修正後才成功」。

可用以下方式減少循環：

1. push 前執行 §1 的完整指令；
2. 將暫存 Git repository 視為隔離 fixture，明確設定 identity 與 cleanup；
3. 避免 literal platform path 與 global-tool 假設；
4. 檢查每個失敗的 matrix job，不只第一個 failure；以及
5. 清楚區分 local validation 與最終 GitHub Actions 結果。

## 4. 讀取 failure

1. 開啟最新的 **CI** workflow run，而不是 Copilot agent workflow。
2. 確認失敗的 OS 與 Node version。
3. 先讀第一個 failed assertion 或 hook error；後面的 cleanup error 可能只是次要結果。
4. 先重跑最小受影響檔案，例如：

   ```bash
   npx vitest run test/update-integration.test.ts
   ```

5. 最後執行 `npm run typecheck && npm test`。


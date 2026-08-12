# Late `/end` fallback race 修正報告

## 範圍與決策

基準為 `94a6f039f62707c20d999307545bf559a26d7fe8`。修正 commit-failure replacement 的
初次 disconnect await 中 `/end` 搶先結束時，fallback 尚未註冊而仍以 restore 計畫進入
retry 的競態。

採用單一路徑：一旦 ownership 已失去，既有或即將建立的 fallback 都先改為 `remove`；
`abandonEndedRebind()` 改為 join 已追蹤 actor 的 teardown，僅由
`reconcileFallbackPrimary()` 的 identity CAS 同時移除 primary target 與 tracker。
沒有 fallback 的既有 terminal stale-row 路徑維持原行為。

## TDD 證據

1. 先新增精確 interleaving regression：replacement 初次 commit-failure disconnect 暫停，
   `/end` 在 fallback 註冊前完成，之後才釋放初次 disconnect。
2. 未修正前執行該測試失敗：`fallbackPrimary.action` 實際為 `restore`，預期為 `remove`
   （`test/app-rebind.test.ts:1248`）。
3. 實作 ownership-loss plan conversion 與 tracker-joined CAS cleanup 後，同一測試通過。
4. 新增兩個 failure/cleanup 路徑斷言：
   - replacement retry disconnect 未確認時，target `creating` reservation 與 tracker 都保留；
     明確 retry 確認後才移除 target、tracker 與 replacement worktree。
   - remove CAS 模擬無法持久化時，已安全清除的 old/replacement worktree 不會復活 session，
     但 target barrier 與 tracker 保留；恢復 CAS 後才一併清除。

## 驗證

```text
npx vitest run test/app-rebind.test.ts test/app-reconcile.test.ts test/session-store.test.ts \
  --maxWorkers=1 --fileParallelism=false
# 3 files, 114 passed

npm run typecheck
# passed

npm test
# exit 0
```

## Council / Rubber Duck Review

| 檢視角度 | 結論與來源 |
| --- | --- |
| ownership | `src/app.ts` 在 fallback 建立前重查 `ownsOldSession()`，並在 `retainStaleRebindActor()` 排程前將 restore plan 改為 remove。 |
| atomic durability | 已存在 fallback 時 `abandonEndedRebind()` join `disconnectStaleRebindActor()`；後者唯一呼叫 `reconcileFallbackPrimary()`，CAS 失敗不會刪 target 或 tracker。 |
| worktree safety | `reclaimStaleRebind()` 仍先確認 disconnect，再用 `removeWorktreeIfClean()`；回歸測試驗證 old tree 在 `/end` 清理、replacement tree 僅在 confirmed teardown 後清理。 |
| no resurrection | remove plan 清除 restore callbacks；兩個 race tests 都在 `/end` 後驗證 `sessions` 沒有重新建立。 |

Rubber Duck 問題：「每個 await 之後，target、actor、worktree 由誰持有？」答案是：
未確認 disconnect 時由 target barrier + `staleRebindActors` 持有；確認後由同一 CAS 一起釋放；
CAS 失敗則兩者都留下。因此不存在先刪 target、後留下無法再對帳 tracker 的路徑。

## 殘留風險

若 SDK 永遠不確認 disconnect，系統刻意保留 target barrier、tracker 與未清的 replacement
worktree，避免刪除可能仍被 runtime 使用的目錄；操作者可稍後 retry 或重啟。

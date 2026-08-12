# Rebind stale-ownership lifecycle report

## 結果

已修補 rebind 在 map swap 前後遺失舊 incarnation 所有權的路徑。`SessionStore` 升級為 v5：
主 thread record 以外的 `staleRebinds` 使用既有 `blocked` terminal state，依
`(threadId, sessionId, generation)` 保存舊 binding、worktree、branch 與原因；因此 live
replacement 不會覆蓋可能仍存活的舊 actor 唯一耐久指標。

`DiscordCopilotApp` 的 `staleRebindActors` 現持有 actor、owner thread、immutable binding 與
cleanup plan。舊 actor 的 trusted root 只有在 bounded disconnect 確認後才釋放；正常 rebind、
`/end` 和 shutdown 都 join/retry 同一個 tracked lifecycle。`/end` 在 map swap 後會處理
replacement 與所有舊 incarnation；未確認者留下 durable `rebind-teardown-unconfirmed` 指標，
確認者只經 `removeWorktreeIfClean` 再次證明安全後才清 worktree。

## TDD evidence

先新增並執行失敗測試：

```text
npx vitest run test/session-store.test.ts test/app-rebind.test.ts
```

失敗原因包括缺少 `retainStaleRebind`，以及 post-swap old actor 不在
`staleRebindActors`。實作後新增覆蓋：

- post-swap 舊 actor teardown 失敗時的 durable tracker、root fence 與後續 retry；
- `/end` map-swap 交錯時 replacement 與舊 clean worktree 都被處理；
- unconfirmed old 的重啟安全 terminal pointer 與後續 explicit retry；
- pre-swap failed rollback + `/end` race 不遺失 old pointer；
- startup announcement 將 terminal stale pointer 視為有記錄的 leftover，而不是 stray worktree。

## Verification

```text
npx vitest run test/app-rebind.test.ts test/app-reclaim.test.ts \
  test/app-reconcile.test.ts test/worktree.test.ts test/session-store.test.ts
# 5 files, 117 passed

npm run typecheck
# passed

npm test
# 62 files, 1058 passed, 5 skipped
```

## Council / Rubber Duck review

| 檢視角度 | 結論與依據 |
|---|---|
| lifecycle ownership | old binding 在 `reserve()` 覆寫主 record 前先 durable；map swap 前 actor 轉入 tracker，`/end`、normal completion、shutdown 皆以 owner thread retry。`app-rebind.test.ts` 的四個新 interleaving regression cases 綠燈。 |
| durability / restart | v5 parser 僅接受 `blocked` + `rebind-*` stale rows，且 stale identity 包含 generation；reconcile 不 resume 它們，startup announcement／`/sessions` 仍列出它們。`session-store.test.ts` reload 與 `app-reconcile.test.ts` announcement case 綠燈。 |
| destructive safety | old cleanup 同時受 rebind preflight 與 `removeWorktreeIfClean` 的第二次 git proof 保護；dirty、detached、unknown 或 unconfirmed runtime 都只保留 record。`app-reclaim.test.ts`、`worktree.test.ts` 綠燈。 |
| no resurrection | `/end` 標記 instance 後，rebind only abandons target resources；rollback 不 restore a terminal old pointer into the active slot。map-swap and pre-swap end-race tests 綠燈。 |

Rubber Duck walkthrough：先問「此 await 之後誰還持有 actor/root/worktree？」；對 target
prepare、reserve/create、map swap、old teardown、`/end`、shutdown 逐一驗證都有主 record、
terminal stale record 或 strong actor tracker 至少一個所有者。唯一刻意保留的路徑是 runtime 永遠
不確認 teardown，見下方 concern。

## Residual concern

若 SDK 永遠不確認 disconnect，系統刻意不刪除其 trusted-root fence 或 worktree；v5 terminal
record 會保留並在 `/sessions`／startup leftover notice 顯示，供 restart 後的操作者確認與清理。

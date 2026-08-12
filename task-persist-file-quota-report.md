## 2026-08-12
- Root cause: `asRecord()` migrated pre-v4 rows in memory but preserved legacy row `schemaVersion`, so a later write could leave a persisted wrapper at schema v4 while an individual row still claimed v3; if `fileDeliveryBytes` was then missing, restart re-entered the v3 migration path and reset the quota to `0`.
- Fix: canonicalized persisted rows to schema v4 on read/write/restore by returning `schemaVersion: 4` from `asRecord()` after a successful legacy migration and by normalizing every stored row through `canonicalizeRecord()` before durability. This preserves the one-time v1-v3 `fileDeliveryBytes -> 0` migration but prevents any successfully persisted v4 row from being treated as legacy again.
- Regression test added in `test/session-store.test.ts`: start from a v3 row without `fileDeliveryBytes`, reserve `42` bytes, assert the persisted wrapper and row are both schema v4, then simulate a restart from a hand-edited persisted row missing `fileDeliveryBytes` and verify `SessionStore` marks the file corrupt and returns no sessions.
- Verification evidence:
  - RED check: new regression was added first; full `npx vitest run test/session-store.test.ts` initially stayed green because the repository already contained a partial quota persistence fix, confirming this exact migration flaw was still untested before the new regression.
  - GREEN check: `npx vitest run test/session-store.test.ts` ✅
  - Typecheck: `npm run typecheck` ❌ pre-existing unrelated failure in `src/app.ts` (`yoloOnWarning` missing; `session.actor.hasRepoSkills` missing).
  - Full suite: `npm test` ❌ same pre-existing YOLO issue surfaced via `test/app-channels.test.ts`.

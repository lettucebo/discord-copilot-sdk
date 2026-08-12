# ADS / Upload Outcome / Lease Release Report

## Status

All five release blockers and the Discord setup documentation inconsistency are addressed.

## Changes

- Windows outbound artifact resolution rejects `:` in root-relative request components before opening and in handle-derived relative paths before Git, extension, or display checks.
- Unknown `channel.send()` failures now return `upload-outcome-unknown`, emit a best-effort no-mention exposure warning, and remain truthful through actor and `/file` lifecycle cancellation.
- Resume terminal transitions now persist before a local lease is released; persistence failure is fatal to reconciliation.
- `/end` holds a local lease through durable cleanup, preserves/reacquires it on write failure, and releases an old lease only after a pre-swap rebind no longer has a durable local claim.
- Channel-lockdown setup masks now list `Attach Files` only for Windows (`395137371200`); non-Windows uses `395137338432`.
- `docs/PLAN.md` §18 records the rationale, residual risk, and test mapping.

## TDD and Verification

- RED/GREEN regressions were added for Windows ADS, accepted-upload/lost-response cancellation, resume persistence failure, `/end` lease admission/removal failure, pending-rebind lease cleanup, and dual-language lockdown masks.
- `npx vitest run test/outbound-file.test.ts test/transport.test.ts test/session-actor.test.ts test/app-file-command.test.ts test/app-reconcile.test.ts test/app-rebind.test.ts test/app-channels.test.ts test/channel-registry.test.ts test/file-delivery-docs.test.ts` — passed (315 tests).
- `npm run typecheck` — passed.
- `npm test` — passed.
- `git diff --check` — passed.

## Council and Rubber-Duck Review

- Security: ADS checks preserve drive designators while blocking stream-qualified `.git` and executable names; all new Discord warnings suppress mentions.
- Truthfulness: explicit Discord rejection codes retain known failure mappings; unknown send results never become `cancelled` or a quota success.
- Durability/concurrency: terminal state writes precede lease release; end cleanup denies concurrent local admission until the durable transition succeeds.

## Concerns

None known. An unknown upload response cannot be retracted because Discord supplied no message ID; the structured result and best-effort warning explicitly disclose that residual exposure.

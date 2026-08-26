---
goal: Synchronize all installation, configuration, operator, and architecture documentation with the private-channel Discord whitelist implementation
version: 1.0
date_created: 2026-08-26
last_updated: 2026-08-26
owner: lettucebo
status: 'Completed'
tags: [documentation, discord, configuration, installation, authorization, migration]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan makes every user-facing and contributor-facing document describe the implemented Discord access model consistently: private channels are the primary bot-visibility whitelist, `/channel` is the independent authorization boundary, `DISCORD_PARENT_CHANNEL_ID` is a first-run default rather than a permanent channel, Discord Integrations is an optional secondary command-permission layer, and reversible Discord `no-access` remains retryable and explicitly clearable.

## 1. Requirements & Constraints

- **REQ-001**: Update every English and Traditional Chinese documentation twin together: `README.md` / `README.zh-TW.md`, `INSTALL.md` / `INSTALL.zh-TW.md`, `docs/DISCORD-SETUP.md` / `docs/DISCORD-SETUP.zh-TW.md`, and `docs/CHANNEL-ACCESS.md` / `docs/CHANNEL-ACCESS.zh-TW.md`.
- **REQ-002**: Make the primary setup workflow deterministic: create a private text channel, add the intended bot application and human operators, grant the documented work-channel permissions, start the bot, run `/channel enable`, then execute positive and negative verification.
- **REQ-003**: Remove instructions that require denying `VIEW_CHANNEL` separately on every other channel/category. That is blacklist maintenance and contradicts the selected private-channel whitelist model.
- **REQ-004**: Preserve Discord Integrations command permissions as a clearly secondary option for non-admin allow-listed users and defense-in-depth. State that bot-token automation is impossible because updates require a human OAuth bearer token with `applications.commands.permissions.update`.
- **REQ-005**: Describe `default_member_permissions="0"` accurately: guild owners and Administrators can use commands; other allow-listed users require an explicit Discord Integrations user/role override.
- **REQ-006**: Describe `DISCORD_PARENT_CHANNEL_ID` as a required first-run default imported once into registry schema v2, after which it is an ordinary removable enabled-channel record. Editing `.env` after registry creation does not change authorization.
- **REQ-007**: Describe Channel Obfuscation accurately: Gateway stubs may use `CHANNEL_OBFUSCATED` (`1 << 17`) and `"___hidden___"`; HTTP may omit inaccessible channels; interaction payloads are separate; `403`/`50001`/obfuscation map to retryable `thread-no-access`, while deletion and structural mismatch remain terminal.
- **REQ-008**: Correct `/channel list` documentation: it audits enabled channels against actual Discord visibility and reports drift; it does not show authorization only.
- **REQ-009**: Correct `/sessions` documentation and UI: `thread-no-access` records remain retryable but can be explicitly cleared with `/end thread:<id>`; unrelated transient retry-pending records remain protected from deletion.
- **REQ-010**: Update the installer completion message so the manual next step says to add the bot to the private work channel, start it, run `/channel enable` when needed, and follow the INSTALL positive/negative verification checklist—not merely “send a message or use `/new`.”
- **REQ-011**: Update contributor-facing truth sources: `.github/copilot-instructions.md`, `docs/PLAN.md`, `CONTEXT.md`, both Discord whitelist ADRs, and `CHANGELOG.md`.
- **REQ-012**: Add automated documentation-contract tests that assert required phrases/semantics and reject the known stale claims.
- **SEC-001**: Continue treating `/channel` as the real authorization boundary because Discord may deliver an interaction independently of ordinary message-read permissions.
- **SEC-002**: Never recommend `Administrator`, `Manage Channels`, or `Manage Roles` for the bot. The bot must not modify its own visibility permissions.
- **SEC-003**: Never claim that a bot token can update Application Command Permissions.
- **SEC-004**: Do not claim Discord prevents users from syntactically typing a bot mention. State only the verifiable behavior: the bot does not receive/read/respond to messages in channels it cannot view, and the negative test confirms actual behavior.
- **CON-001**: Preserve the repository’s bilingual-document convention and internal language switchers.
- **CON-002**: Preserve unrelated installation, residency, update, uninstall, file-delivery, and security instructions.
- **CON-003**: Do not modify user-owned untracked `AGENTS.md` or `docs/agents/`.
- **CON-004**: Do not add dependencies; documentation tests use existing Node/Vitest facilities.
- **GUD-001**: Lead users from the simplest supported primary workflow to optional advanced layers; do not mix primary and fallback procedures in one checklist.
- **PAT-001**: Use `docs/CHANNEL-ACCESS.md` and its zh-TW twin as the authoritative three-plane model; other documents summarize and link to it rather than re-specifying contradictory rules.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Resolve the remaining operator-UX mismatch before documenting final behavior.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Update `src/app.ts` in `cmdSessions` so records with `reason === "thread-no-access"` render under a **third, distinct section**: retryable after access is restored/restart, but explicitly and manually clearable with `/end thread:<id>`. Do not place these records in either the terminal `reapable` section (which would hide retryability) or the non-clearable transient `pending` section. Keep all other `retry-pending` records under the non-clearable retry heading. | ✅ | 2026-08-26 |
| TASK-002 | Add/extend tests in `test/app-reconcile.test.ts` or `test/app-reclaim.test.ts` to assert the exact `/sessions` classification and retain the existing `/end thread:<id>` cleanup regression test. | ✅ | 2026-08-26 |

### Implementation Phase 2

- GOAL-002: Make installation and first-run configuration describe one deterministic private-channel workflow.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Update `INSTALL.md` and `INSTALL.zh-TW.md`: revise prerequisites, document what the installer asks for, explain the first-run default, replace the one-line “Final step” with the complete private-channel setup/start/enable/positive-negative verification checklist, and add troubleshooting for non-admin command visibility, invisible channels, and `thread-no-access`. | ✅ | 2026-08-26 |
| TASK-004 | Update `docs/DISCORD-SETUP.md` and `docs/DISCORD-SETUP.zh-TW.md`: replace the current §4b blacklist procedure (“deny every other channel/category”) with the primary private-channel membership procedure; retain least-privilege permission masks, `default_member_permissions="0"`, multi-instance isolation, Channel Obfuscation testing, ID collection, channel replacement, and verification. Remove the obsolete operational claim that setup order matters because “the bot loses `Manage Roles` and can no longer edit channel permissions”; humans configure these permissions. Preserve the least-privilege table row that says `Manage Channels` / `Manage Roles` are deliberately **not granted**. Normalize `seed channel`, `primary channel`, and `seed/primary work channel` to the canonical domain term `seed default`; use `first-run default` only as its user-facing descriptive synonym. | ✅ | 2026-08-26 |
| TASK-005 | Update `.env.example` and `scripts/lib/i18n.mjs`: make `promptParentChannelId` and `doneManual` use the same “first-run default + private channel + `/channel` audit” terminology in both languages. `doneManual` must direct the operator to the INSTALL positive/negative verification checklist. Do not change config keys or validation. | ✅ | 2026-08-26 |

### Implementation Phase 3

- GOAL-003: Synchronize operator summaries and the authoritative access model.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Update `README.md` and `README.zh-TW.md`: correct the security-model paragraph that currently says the bot reads every channel by default, include required guild/channel IDs, correct `/channel list` from “authorization only” to visibility audit, describe `thread-no-access` cleanup, and link to the full private-channel installation workflow. | ✅ | 2026-08-26 |
| TASK-007 | Update `docs/CHANNEL-ACCESS.md` and `docs/CHANNEL-ACCESS.zh-TW.md`: preserve the three-plane model and Integrations fallback; clarify mention wording, `/sessions` and `/end thread:<id>` behavior, first-run registry authority, the order for adding/removing channels, and the exact positive/negative/obfuscation checks. Remove any remaining “seed channel” fallback language. | ✅ | 2026-08-26 |

### Implementation Phase 4

- GOAL-004: Synchronize contributor-facing architecture and decision records.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | Update `.github/copilot-instructions.md`: replace the stale “`DISCORD_PARENT_CHANNEL_ID` seed or registry entry” rule with “durable registry entry, initialized once from the configured default”; describe private-channel visibility as primary and Integrations as secondary; document `thread-no-access` as retryable and explicitly clearable. | ✅ | 2026-08-26 |
| TASK-009 | Update `docs/PLAN.md` §13.3/§13.4: replace pre-implementation test mappings (`seed always enabled`, “implementation pending”) with the implemented registry-v2 migration, obfuscation, no-access retry/cleanup, default command permissions, and visibility-audit tests. Preserve historical rationale. | ✅ | 2026-08-26 |
| TASK-010 | Update `CONTEXT.md`, `docs/adr/0001-private-channel-whitelist.md`, and `docs/adr/0002-missing-access-is-retryable.md` only where needed to align canonical terms and explicit cleanup behavior; keep `CONTEXT.md` implementation-free. Under `Seed default`, record `first-run default` as the accepted descriptive synonym used by operator docs, while `seed channel`, `primary channel`, and `default channel` remain avoided terms. | ✅ | 2026-08-26 |
| TASK-011 | Add concise entries under `CHANGELOG.md` → `[Unreleased]` for private-channel visibility whitelisting, registry-v2 first-run-default migration, retryable Discord no-access, and the removal of dead config surfaces. State that legacy `DEV_GUILD_ID` / `PERMISSION_POLICY` lines are ignored by runtime parsing rather than rejected; do not describe this removal as breaking. | ✅ | 2026-08-26 |

### Implementation Phase 5

- GOAL-005: Prevent documentation drift and verify every changed surface.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | Add `test/channel-access-docs.test.ts` (or extend `test/shipped-scripts.test.ts` when reuse is clearer) to verify all four bilingual pairs remain linked and contain the primary private-channel workflow, `seed default` / first-run-default semantics, visibility-audit wording, Integrations fallback, `default_member_permissions="0"`, and `thread-no-access` cleanup. Reject exact stale substrings that exist in the current files: English `shows **bot authorization** only` and `Every other channel and category`; zh-TW `顯示的只是 **bot authorization**` and `其他每一個頻道與分類`. Do not ban broad tokens such as `seed`, `authorization`, or `永遠`. Positively require the canonical `seed default` where that concept is documented. Scope the positive three-plane/audit assertion specifically to the Channel Access twins: require English `bot authorization` in `docs/CHANNEL-ACCESS.md` and translated `bot 授權` / `Bot 授權` in `docs/CHANNEL-ACCESS.zh-TW.md`; do not require README or INSTALL to retain either literal phrase. | ✅ | 2026-08-26 |
| TASK-013 | Extend `test/i18n.test.ts` to require semantically aligned zh/en `promptParentChannelId` and `doneManual` strings containing the private-channel manual step and a pointer to the INSTALL positive/negative verification checklist. | ✅ | 2026-08-26 |
| TASK-014 | Run `npm run typecheck`, targeted documentation/config/i18n/app tests, `npm test`, `npm run build && node dist/index.js --selfcheck`, `git diff --check`, `bash -n install.sh` using Git Bash on Windows, and `node --check` for `scripts/*.mjs` plus `scripts/lib/*.mjs`. | ✅ | 2026-08-26 |
| TASK-015 | Run a fresh Council review with two contrasting models plus a fresh Rubber Duck review. Fix every high-confidence finding, rerun affected tests, and repeat review until no meaningful issue remains. | ✅ | 2026-08-26 |

## 3. Alternatives

- **ALT-001**: Update only `docs/CHANNEL-ACCESS*` and link everything else to it. Rejected because README, INSTALL, Discord setup, installer completion text, and contributor instructions already contain contradictory procedural claims; links do not neutralize incorrect local instructions.
- **ALT-002**: Keep the current deny-every-other-channel/category procedure as an equal primary option. Rejected because it is blacklist maintenance, scales poorly for new channels, and contradicts the user-selected private-channel whitelist.
- **ALT-003**: Remove Discord Integrations command permissions entirely. Rejected because non-admin allow-listed users need an explicit override when commands use `default_member_permissions="0"`, and Integrations remains valid defense-in-depth.
- **ALT-004**: Change installer behavior to create/configure Discord channels automatically. Rejected because a bot token cannot safely create the required human visibility policy or update Application Command Permissions, and the installer has no human Discord OAuth credential.
- **ALT-005**: Document `thread-no-access` as non-clearable because it is retryable. Rejected because the implemented explicit-owner `/end thread:<id>` escape hatch deliberately permits irreversible cleanup after informed operator choice.

## 4. Dependencies

- **DEP-001**: Current implementation in `src/app.ts`, `src/core/channel-registry.ts`, `src/core/reconcile.ts`, `src/core/session-store.ts`, and `src/platforms/discord/channel-fetch.ts`.
- **DEP-002**: Discord Channel Obfuscation change log dated 2026-08-12 and mandatory date 2026-11-16.
- **DEP-003**: Discord Application Command Permissions documentation for `default_member_permissions` and human OAuth update requirements.
- **DEP-004**: Existing bilingual-link and relative-link tests in `test/shipped-scripts.test.ts`.
- **DEP-005**: Existing config contract between `src/config.ts` and `scripts/lib/validate.mjs`.

## 5. Files

- **FILE-001**: `src/app.ts` — `/sessions` operator classification text.
- **FILE-002**: `test/app-reconcile.test.ts`, `test/app-reclaim.test.ts` — no-access listing/cleanup behavior.
- **FILE-003**: `README.md`, `README.zh-TW.md` — project-level security, requirements, and channel workflow.
- **FILE-004**: `INSTALL.md`, `INSTALL.zh-TW.md` — installation/configuration/first-run workflow.
- **FILE-005**: `docs/DISCORD-SETUP.md`, `docs/DISCORD-SETUP.zh-TW.md` — Discord application, permissions, private-channel setup.
- **FILE-006**: `docs/CHANNEL-ACCESS.md`, `docs/CHANNEL-ACCESS.zh-TW.md` — authoritative access model.
- **FILE-007**: `.env.example`, `scripts/lib/i18n.mjs` — configuration comments and installer prompts/completion.
- **FILE-008**: `.github/copilot-instructions.md`, `docs/PLAN.md` — contributor architecture/rationale.
- **FILE-009**: `CONTEXT.md`, `docs/adr/0001-private-channel-whitelist.md`, `docs/adr/0002-missing-access-is-retryable.md` — domain vocabulary and decisions.
- **FILE-010**: `CHANGELOG.md` — unreleased user-visible behavior.
- **FILE-011**: `test/channel-access-docs.test.ts`, `test/i18n.test.ts` — documentation drift prevention.

## 6. Testing

- **TEST-001**: `/sessions` renders `thread-no-access` as retryable and manually clearable; other transient active records remain non-clearable.
- **TEST-002**: `/end thread:<id>` clears only the explicitly permitted `thread-no-access` active record path.
- **TEST-003**: English/zh-TW twin documents contain matching links and required whitelist semantics.
- **TEST-004**: Current guidance contains none of the exact stale English/zh-TW phrases enumerated in TASK-012, while canonical `seed default` and three-plane `bot authorization` wording remains permitted.
- **TEST-005**: Installer zh/en `promptParentChannelId` and `doneManual` both describe the first-run default/private-channel manual step and point to the INSTALL positive/negative checklist.
- **TEST-006**: Existing runtime/installer config-contract corpus remains green; no key behavior changes.
- **TEST-007**: Repository typecheck, build, SDK selfcheck, full tests, script syntax checks, and diff whitespace checks pass.

## 7. Risks & Assumptions

- **RISK-001**: Discord UI labels and navigation may change. Mitigate by documenting both the conceptual permission and the current UI path, and retaining authoritative Discord links.
- **RISK-002**: Discord command visibility behavior has weaker first-party wording than authorization behavior. Preserve the evidence-level disclaimer and require a live negative test.
- **RISK-003**: Over-compressing the setup guide can omit Windows-only file permission differences. Preserve the existing platform-specific invite masks and Attach Files rules.
- **RISK-004**: Updating `docs/PLAN.md` can erase historical rationale. Modify only invalidated status/test-mapping statements and preserve rejected alternatives.
- **RISK-005**: A documentation-only wording change could accidentally claim the bot cannot be syntactically mentioned. Use receipt/read/response language instead.
- **ASSUMPTION-001**: The installed bot uses one Discord application/token per bot instance.
- **ASSUMPTION-002**: A human server administrator creates private channels and adds bot/human members before `/channel enable`.
- **ASSUMPTION-003**: `DISCORD_PARENT_CHANNEL_ID` remains required for first-run bootstrap but is not authoritative after the registry exists.
- **ASSUMPTION-004**: Existing untracked `AGENTS.md` and `docs/agents/` remain outside this task.

## 8. Related Specifications / Further Reading

- [Channel access model](../docs/CHANNEL-ACCESS.md)
- [Discord setup](../docs/DISCORD-SETUP.md)
- [ADR-0001: Private Discord channels are the primary command/visibility whitelist](../docs/adr/0001-private-channel-whitelist.md)
- [ADR-0002: Missing Access is retryable; structural mismatch stays terminal](../docs/adr/0002-missing-access-is-retryable.md)
- [Discord Application Commands permissions](https://docs.discord.com/developers/interactions/application-commands#permissions)
- [Discord Developer Platform change log](https://docs.discord.com/developers/change-log)

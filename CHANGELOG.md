<!-- English-only by design: this is the source for one GitHub Release per tag.
     Version policy: on 0.x, breaking => minor, feat => patch, and fix/perf/security fixes => patch; on >=1.0.0, breaking => major, feat => minor, and fix/perf/security fixes => patch. If there are no release-worthy commits, do not invent a version.
     The tag workflow publishes the finalized CHANGELOG section for that version as the GitHub Release body first, then appends GitHub-generated notes.
     User-facing installation documentation remains maintained as en/zh-TW twins. -->

# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- wait for full startup readiness

## [1.0.0] - 2026-08-09

First published release. No earlier version was ever tagged, so this section consolidates
everything shipped in this repository to date.

### Added

- Discord-native control of a local GitHub Copilot session: one thread per session, with the
  agent's messages, tool calls and todo checklists streamed into the thread.
- Approve-per-command shell permissions rendered as Discord buttons, plus `ask_user`
  choices/free-text answers and exit-plan approval.
- Wider approval scopes remembered by the bot: "Allow for session" and "Always (this repo)",
  with revocation that an in-flight card cannot settle against.
- Opt-in per-session `/yolo mode:on` blanket auto-approval that is never persisted and comes
  back off after a restart or a session recovery.
- Slash commands for session control and observability: `/model`, `/effort`, `/context`,
  `/usage`, `/approvals`, `/queue`, `/stop` and `/channel`, plus steering a running turn with a
  plain thread message.
- Concurrent sessions isolated from each other by a dedicated git worktree per thread.
- Multi-repo binding under a repos root, where git proves which repository a session is bound to.
- Crash-safe session resume and startup reconciliation backed by durable thread-session records.
- Invite-only Discord channel access with a durable channel registry.
- A bilingual (English / Traditional Chinese) cross-platform installer, uninstaller, run/stop
  helpers and 24/7 residency.
- A fail-closed local update engine with network-safe bootstrap entrypoints and version reporting.
- SemVer release automation: a read-only `--plan` proposal, a `--notes` extractor, and a
  tag-driven workflow that publishes the curated changelog section before generated notes.

### Security

- The controlled repository cannot reconfigure the agent: file hooks, config discovery, skills
  and custom instructions are disabled, and `DISCORD_*` / `DISCORD_COPILOT_SDK_*` values are
  stripped from the agent's environment.
- Shell approval cards are spoofing-resistant: the command is escaped, and a command containing
  bidirectional or control characters is auto-denied rather than shown.
- The repos root must be disjoint from the trust store in both directions, so no agent working
  directory can contain the bot's own state.
- Permission kinds and interactive callbacks that are not explicitly supported fail closed.

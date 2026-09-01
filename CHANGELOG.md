<!-- English-only by design: this is the source for one GitHub Release per tag.
     Version policy: on 0.x, breaking => minor, feat => patch, and fix/perf/security fixes => patch; on >=1.0.0, breaking => major, feat => minor, and fix/perf/security fixes => patch. If there are no release-worthy commits, do not invent a version.
     The tag workflow publishes the finalized CHANGELOG section for that version as the GitHub Release body first, then appends GitHub-generated notes.
     User-facing installation documentation remains maintained as en/zh-TW twins. -->

# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **Private-channel visibility as the primary Discord whitelist**: making a work channel private
  and adding only the intended bot application now yields Discord-native "invisible channel
  means no commands, no content" behavior, with no Discord Integrations configuration or human
  OAuth grant required. Integrations remains available as a secondary, admin-only override.
- **Channel registry schema v2**: `DISCORD_PARENT_CHANNEL_ID` is imported once, only on a
  missing or v1 registry file, as an ordinary enabled-channel record rather than a permanent
  seed, and from then on can be removed like any channel added via `/channel enable`. An
  existing v1 registry file is migrated in place, preserving every previously enabled channel.
- `/channel list` now audits Discord visibility instead of reporting authorization only: it
  flags enabled channels the bot can no longer see, and visible text channels that are not yet
  enabled, so registry/Discord drift is surfaced rather than hidden.

### Changed

- **Losing Discord channel access (`50001 Missing Access`, including Channel Obfuscation) is
  now retryable, not a terminal block**: an affected session resumes automatically once access
  is restored — the running bot rescans its `thread-no-access` records on a bounded periodic
  timer (15s, backing off to at most every 5 minutes), so recovery no longer requires a
  restart — `/sessions` lists it separately from both permanently blocked and other
  transient-retry records, and an owner can still explicitly clear it with
  `/end thread:<id>` after deciding to give up on recovery.
- Slash commands now register with `default_member_permissions="0"`: only the guild owner or an
  Administrator can invoke them by default, and every other allow-listed user needs an explicit
  Discord Integrations user/role override.

### Removed

- The legacy `DEV_GUILD_ID` and `PERMISSION_POLICY` config keys are gone. A remaining `.env`
  line for either is silently ignored by the runtime config parser rather than rejected — this
  is not a breaking change, since neither key has affected behavior for some time.

## [1.1.0] - 2026-08-18

### Added

- **Ordered timeline rendering in threads**: assistant text, reasoning and tool calls now render
  in the order they occurred, with thinking collapsed behind Discord spoilers and reasoning
  markdown delimiters neutralized so they cannot break the spoiler. The todo checklist is
  maintained as a single progress projection rather than a chronological entry. New sessions
  request detailed reasoning summaries; providers that keep summaries opaque may still display
  none.
- **Repository and user skills, enabled by default**: sessions explicitly load the CLI-native
  roots `.github/skills`, `.agents/skills` and `.claude/skills` from the bound repository, plus
  `~/.copilot/skills`, without enabling broad config or MCP discovery. Each source is switchable
  through the new `ENABLE_REPO_SKILLS` / `ENABLE_USER_SKILLS` settings, which the installer
  prompts for and which default to `true`. When no enabled root is found to contain a
  `SKILL.md`, the builtin `skill` tool is removed rather than left able only to fail. A git
  worktree sees committed skills only.
- **Outbound file delivery (Windows hosts only)**: `/file path:<path>` uploads a validated file
  from the session workdir into the owning thread. An agent can also propose
  `discord_send_file({path, comment?})`, which requires its own Allow-once card and is
  additionally limited to three successful deliveries per turn and a 24 MiB per-thread byte
  budget that is persisted before the send and survives resume and rebind. Both paths are
  confined to the session workdir and share Discord's 8 MiB per-file cap.
- **Durable approval audit log**: before an auto-approved tool runs, the bot appends and fsyncs
  a bounded JSON line (timestamp, session key and a bounded description -- never the payload) to
  `~/.discord-copilot-sdk/<instance>.audit.jsonl`.
- **Structured installer and updater output**: the installer and updater now report
  phase-oriented status, keep `npm install` quiet unless it fails, state install completion
  explicitly, fail the install when the setup log stream errors, and report update checks and
  applies as structured status rather than raw command output.
- `npm run smoke:skills`, a manual acceptance probe that verifies skill loading against the real
  Copilot runtime.
- `docs/CI-TROUBLESHOOTING.md` and its Traditional Chinese twin for contributors.

### Changed

- **Skills are now loaded by default, where the previous release loaded none.** A bound
  repository's skill names and descriptions therefore enter the model context after upgrading.
  This does not enable config or MCP discovery, and a skill's `allowed-tools` frontmatter was
  verified not to bypass Discord approval cards. To keep the previous behaviour, set
  `ENABLE_REPO_SKILLS=false` and `ENABLE_USER_SKILLS=false`.
- **Windows hosts now need Discord's `Attach Files` permission.** `docs/DISCORD-SETUP.md`
  publishes per-platform invite masks. An existing installation keeps working for text, but
  `/file` and approved agent file sends fail until you re-authorize the application or grant the
  permission on the channel.
- YOLO mode is deliberately not blanket approval for file delivery: enabling it revokes an
  already-pending `discord_send_file` card and fast-denies later agent file-send requests with
  guidance to use `/file` instead. The enable warning now also calls out repository skills,
  because skill text can steer the model once the approval gate is removed.

### Fixed

- An explicit Discord denial now returns the deny payload the local Copilot runtime accepts; the
  SDK-declared "denied interactively by user" variant was rejected as malformed.
- The updater applies exactly the revision it resolved, fetching it through a UUID-scoped
  private ref so a concurrent remote update cannot change what is applied after it was shown.
- A private fetch ref that could not be cleaned up is now named in a warning alongside the
  original failure, instead of being left behind silently.
- Recovery guidance survives a failed restore, so an interrupted update still reports the
  instance-qualified command that recovers it.

### Security

- Auto-approval fails closed on audit-log write failure: if the record cannot be persisted, YOLO
  and remembered-rule approvals deny the request rather than run without an audit trail.
- Outbound file delivery is bound to opened kernel handles and captured trusted-root identities
  rather than path strings. Externally linked artifacts and Windows alternate data streams are
  rejected, size races between validation and send fail closed, and a delivery invalidated by a
  lifecycle change is stopped before the Discord send. If Discord already accepted an
  attachment, the bot retracts it where it can and reports plainly when the upload outcome or
  the retraction could not be confirmed.
- Outbound Discord file delivery is unavailable on Linux, macOS and other non-Windows hosts by
  design: the SDK accepts only a mutable pathname `workingDirectory`, not a retained descriptor,
  so those platforms expose neither `/file` delivery nor `discord_send_file`. All other
  functionality is unaffected.
- Update notes fetched from a remote are bounded and stripped of terminal control sequences
  before they are printed.
- Session rebind and teardown are ownership-fenced: a detached rebind incarnation is persisted
  independently of the mutable thread record and keeps its roots until disconnect is confirmed,
  ownership is retained when a stale write or compare-and-set fails, and `/end` owns both the
  replacement and the old record's cleanup -- so a worktree or a pending attachment can no
  longer be handed to the wrong session.

## [1.0.1] - 2026-08-09

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

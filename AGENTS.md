# discord-copilot-sdk — agent instructions

This repo's conventions, architecture and security context live in
[`.github/copilot-instructions.md`](.github/copilot-instructions.md) — that file is the single
source of truth and should be read first. This file exists only to record where the engineering
skills find their per-repo configuration.

Note: the agent that the *bot* spawns does not automatically load custom instruction files —
`session-actor.ts` and the titler in `app.ts` both pass `skipCustomInstructions: true` (an agent
can still open the file with a tool, like any other file). This file is therefore aimed at
human-driven CLI sessions in this repo, not at sessions the bot creates.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `lettucebo/discord-copilot-sdk`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one root `CONTEXT.md` plus `docs/adr/`, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.

---
name: release
description: 'Use when a human asks to cut, ship, tag, or publish a release, prepare release notes, bump the version, update CHANGELOG for a release, apply SemVer to reachable commits, produce a GitHub Release, or mentions "/release".'
license: MIT
allowed-tools: Bash
---

# Release with SemVer, Curated CHANGELOG, and Tag-Driven Publish

## Overview

`npm run release` creates the release commit + annotated tag locally. `git push --follow-tags` triggers `.github/workflows/release.yml`, which publishes the GitHub Release with the curated CHANGELOG section on top and GitHub-generated notes appended. Never publish by hand.

## Core Principle

`node scripts/release.mjs --plan` proposes a version and draft from commit messages. That output is **evidence, not truth**. Show the proposal, `CHANGELOG DRAFT`, and every `REVIEW BY HAND` entry to a human. The human reviews the diff, picks the final version, and confirms notes **before** the repo is mutated. Never bump because the script suggested it.

## Ordered Recipe

1. **Inspect.** `git status --short --branch`, `git tag --list --sort=-v:refname | head`, `git log --oneline <last-tag>..HEAD`, then `node scripts/release.mjs --plan`.
2. **Read the plan** — current version, baseline tag, proposed version+reason+level, `CHANGELOG DRAFT`, `REVIEW BY HAND`. If it says no release-worthy commits, stop and tell the human.
3. **Ask the human** to confirm the final version and which curated English entries to merge into `## [Unreleased]`. The human owns the version.
4. **Update CHANGELOG and commit** the approved English notes under `## [Unreleased]` (e.g. `docs(changelog): ...`). The release script requires a clean tree; uncommitted edits will abort it.
5. **Release:** `npm run release -- <confirmed-version>`. It bumps `package.json`, rolls `[Unreleased]` into `## [<version>] - <date>`, stages both files, creates `chore(release): v<version>`, and creates annotated tag `v<version>`. It **never pushes.**
6. **Inspect artifacts:** `git show --stat HEAD`, `git cat-file -t v<version>` (expect `tag`), `git tag -n9 v<version>`.
7. **Push atomically:** `git push --follow-tags`. Never push branch and tag in separate commands.
8. **Verify workflow.** Watch `.github/workflows/release.yml` succeed; confirm the GitHub Release shows the curated section above generated notes. **Never** run `gh release create` — the tag workflow is the sole publisher.

## SemVer Policy

Applied to reachable commits since the baseline tag:

| Current | breaking (`!` / `BREAKING CHANGE:`) | `feat` | `fix` / `perf` | `docs` / `chore` / `refactor` / `test` / `ci` / `build` / `style` |
| --- | --- | --- | --- | --- |
| `0.x.y` | **minor** (`0.(x+1).0`) | patch | patch | no release |
| `>=1.0.0` | **major** | minor | patch | no release |

If no reachable commit is release-worthy, `--plan` says so; **do not invent a version.**

`fix(security)` and `fix` commits with `CVE` in the subject are classified into `### Security` but follow the same **patch** version policy as `fix`/`perf` in both current-version rows.

## CHANGELOG Mapping

`draftChangelog()` groups conventional commits: `feat`→`### Added`, `fix`→`### Fixed` (or `### Security` when the subject is `fix(security)` or contains `CVE`), `perf`/`refactor`→`### Changed`, `revert`→`### Removed`, breaking→`### Changed` with a `**BREAKING**` prefix; `docs`/`chore`/`build`/`ci`/`test`/`style` are suppressed. There is no standalone `security:` type — do not rely on one. `release-core` automatically routes non-conventional subjects and any subject containing non-ASCII characters to `REVIEW BY HAND` so `CHANGELOG.md` stays English-only (see its header comment). Automation does **not** catch ASCII-only non-English text (e.g. romanized or transliterated subjects); the agent and human must additionally review every drafted entry and redirect any subject that is not clearly suitable English to `REVIEW BY HAND` for rewrite or translation before it enters `[Unreleased]`.

## `--notes` (workflow + diagnostic)

`node scripts/release.mjs --notes <version>` prints the exact body of `## [<version>]` and **exits non-zero when the section is missing or empty**. The release workflow uses it to build `release-notes.md`. Run it locally to catch empty releases before pushing. No date check; the heading date text is accepted verbatim.

## Update Compatibility

Every pushed `vX.Y.Z` is a valid update ref: `npm run update -- --ref refs/tags/vX.Y.Z` works because the updater peels annotated tags to their commit. Do not delete or move a published tag.

## Common Mistakes

| Mistake (from RED baselines) | Do this instead |
| --- | --- |
| Running `npm run release` before curating CHANGELOG → dated section ships empty. | Curate `[Unreleased]` first (step 4); release only after the human confirms notes. |
| Choosing `1.0.0` for a breaking change while on `0.x`. | Apply the table: on `0.x`, breaking → **minor**. |
| Trusting the proposed version blindly. | Proposal is evidence; the human confirms after reviewing the diff. |
| Improvising hotfix branches, amending release commits, or pushing commit and tag separately under time pressure. | Same recipe under urgency. Push with `git push --follow-tags` so commit + tag land atomically. |
| Running `gh release create` (or clicking "Create release"). | Never. Push the tag; the workflow publishes. Re-run the workflow if it errored. |
| Treating "no release-worthy commits" as license to pick a version. | Stop. Report to the human. No release. |

## Safety

- Never `--force`/`--force-with-lease` or move an existing `v*` tag.
- Never edit `CHANGELOG.md` inside the release commit — curated notes belong in the preceding commit.
- Never bypass hooks (`--no-verify`) unless the human explicitly asks.

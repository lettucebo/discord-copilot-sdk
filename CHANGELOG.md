<!-- English-only by design: this is the source for one GitHub Release per tag.
     Version policy: on 0.x, breaking => minor, feat => patch, and fix/perf/security fixes => patch; on >=1.0.0, breaking => major, feat => minor, and fix/perf/security fixes => patch. If there are no release-worthy commits, do not invent a version.
     The tag workflow publishes the finalized CHANGELOG section for that version as the GitHub Release body first, then appends GitHub-generated notes.
     User-facing installation documentation remains maintained as en/zh-TW twins. -->

# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- A release planning CLI flow that uses `node scripts/release.mjs --plan` as evidence before a human confirms the version and curated English notes.
- A release skill recipe that merges approved English notes into `## [Unreleased]` before `npm run release -- <version>`.
- A tag-driven publish workflow that feeds `node scripts/release.mjs --notes <version>` into the GitHub Release body before generated notes.

## [0.1.0] - 2026-08-06

### Added

- A safe local and network-bootstrap update mechanism with SemVer release identity.

#!/usr/bin/env bash
# discord-copilot-sdk uninstaller (macOS / Linux).
#
#   ./uninstall.sh                # show the plan, ask, then remove everything
#   ./uninstall.sh --dry-run      # show the plan only, change nothing
#   ./uninstall.sh --yes          # no confirmation prompt
#   ./uninstall.sh --keep-config  # keep .env — NOTE: your bot token stays on disk
#   ./uninstall.sh --keep-state   # keep ~/.discord-copilot-sdk
#   ./uninstall.sh --branches     # also delete copilot/t-* branches (merged only)
#   ./uninstall.sh --lang zh|en
#
# A thin bootstrap, exactly like install.sh: it finds node and hands off to
# scripts/uninstall.mjs, so there is ONE implementation to get right and to test.
#
# This never deletes your controlled repo, never touches ~/.copilot (your Copilot
# CLI login), and never removes a worktree that git cannot prove is clean.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FWD=()
LANG_SEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lang) LANG_SEL="$2"; shift 2 ;;
    --yes|-y) FWD+=("--yes"); shift ;;
    --dry-run) FWD+=("--dry-run"); shift ;;
    --keep-config) FWD+=("--keep-config"); shift ;;
    --keep-state) FWD+=("--keep-state"); shift ;;
    --branches) FWD+=("--branches"); shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$LANG_SEL" ]; then
  case "${LANG:-}" in zh*) LANG_SEL=zh ;; *) LANG_SEL=en ;; esac
fi
export DISCORD_COPILOT_SDK_LOCALE
if [ "$LANG_SEL" = "zh" ]; then DISCORD_COPILOT_SDK_LOCALE=zh-TW; else DISCORD_COPILOT_SDK_LOCALE=en-US; fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. The uninstaller needs Node.js. If you removed it, delete these by hand:" >&2
  echo "  $HOME/.discord-copilot-sdk" >&2
  echo "  $HOME/.discord-copilot-sdk-worktrees" >&2
  echo "  $ROOT/.env" >&2
  echo "  systemctl --user disable --now discord-copilot-sdk-default.service" >&2
  exit 1
fi

exec node "$ROOT/scripts/uninstall.mjs" "${FWD[@]+"${FWD[@]}"}" --lang "$LANG_SEL"

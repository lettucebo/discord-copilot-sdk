#!/usr/bin/env bash
# discord-copilot-sdk update entrypoint (macOS / Linux).
#
# Local use:
#   ./update.sh [--check|--dry-run|--ref v0.1.0|--all-instances|--restore]
#
# Network use:
#   curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/update.sh | bash
#
# A network execution downloads the current engine to a private temporary
# directory and points it at the existing checkout. It MUST NOT fetch/checkout
# the target itself: the engine first stops residency and bot processes, then
# changes source, so npm never replaces files still held by a live bot.
set -euo pipefail

REPO_URL="https://github.com/lettucebo/discord-copilot-sdk.git"
RAW_URL="https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk"
REF="${DISCORD_COPILOT_SDK_REF:-main}"
TARGET="${DISCORD_COPILOT_SDK_DIR:-}"
TARGET_EXPLICIT=0
[ -n "$TARGET" ] && TARGET_EXPLICIT=1
FORWARD=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET="${2:-}"; TARGET_EXPLICIT=1; shift 2 ;;
    --ref) REF="${2:-}"; FORWARD+=("--ref" "$REF"); shift 2 ;;
    *) FORWARD+=("$1"); shift ;;
  esac
done

# A script started from disk is the trusted local entrypoint. With `curl | bash`
# BASH_SOURCE is empty; treating its dirname as "." would execute arbitrary CWD
# content instead of the freshly downloaded engine.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/update.mjs" ]; then
  exec node "$SCRIPT_DIR/scripts/update.mjs" "${FORWARD[@]+"${FORWARD[@]}"}"
fi

command -v git >/dev/null 2>&1 || { echo "git is required; run get.sh first." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required; run get.sh first." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required for the network update bootstrap." >&2; exit 1; }

norm() { echo "$1" | sed -e 's/\.git$//' -e 's#/$##' | tr '[:upper:]' '[:lower:]'; }
if [ "$TARGET_EXPLICIT" = "0" ]; then
  TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  ORIGIN=""
  # `remote get-url` expands insteadOf and can make a legitimate mirror look
  # foreign. Compare the literal configuration, matching the updater engine.
  [ -n "$TOP" ] && ORIGIN="$(git -C "$TOP" config --get remote.origin.url 2>/dev/null || true)"
  if [ -n "$ORIGIN" ] && [ "$(norm "$ORIGIN")" = "$(norm "$REPO_URL")" ]; then
    TARGET="$TOP"
  else
    TARGET="$HOME/discord-copilot-sdk"
  fi
fi
[ -n "$TARGET" ] || { echo "A target directory is required." >&2; exit 1; }
[ -d "$TARGET" ] || { echo "Target directory does not exist: $TARGET" >&2; exit 1; }
TARGET="$(cd "$TARGET" && pwd -P)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dcs-update.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM
for file in scripts/update.mjs scripts/lib/update-core.mjs scripts/lib/setup-core.mjs scripts/lib/i18n.mjs; do
  mkdir -p "$TMP/$(dirname "$file")"
  curl -fsSL "$RAW_URL/$REF/$file" -o "$TMP/$file"
done

export DISCORD_COPILOT_SDK_UPDATE_ROOT="$TARGET"
node "$TMP/scripts/update.mjs" "${FORWARD[@]+"${FORWARD[@]}"}"

#!/usr/bin/env bash
# discord-copilot-sdk one-line network bootstrap (macOS / Linux).
#
# Run WITHOUT cloning first:
#   curl -fsSL https://raw.githubusercontent.com/lettucebo/discord-copilot-sdk/main/get.sh | bash
#
# With flags (pass them after --):
#   curl -fsSL .../get.sh | bash -s -- --residency-24x7
#
# Env overrides:
#   DISCORD_COPILOT_SDK_DIR   target directory (default ~/discord-copilot-sdk)
#   DISCORD_COPILOT_SDK_REF   branch/tag to check out (default main)
set -euo pipefail

REPO_URL="https://github.com/lettucebo/discord-copilot-sdk.git"
REF="${DISCORD_COPILOT_SDK_REF:-main}"
TARGET="${DISCORD_COPILOT_SDK_DIR:-$HOME/discord-copilot-sdk}"

case "${LANG:-}" in zh*) ZH=1 ;; *) ZH=0 ;; esac
say() { if [ "$ZH" = "1" ]; then echo "$1"; else echo "$2"; fi; }

# Flags are forwarded verbatim to install.sh; --dir/--ref are consumed here.
FORWARD=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    *) FORWARD+=("$1"); shift ;;
  esac
done

say "discord-copilot-sdk 一鍵安裝（網路啟動器）" "discord-copilot-sdk one-line bootstrap"
say "  目標目錄：$TARGET" "  Target: $TARGET"
say "  分支/標籤：$REF" "  Ref: $REF"

# --- git ---
if ! command -v git >/dev/null 2>&1; then
  say "找不到 git，嘗試安裝…" "git not found; installing…"
  if command -v brew >/dev/null 2>&1; then brew install git
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y git
  else
    echo "Could not install git automatically. Install it, then re-run." >&2
    exit 1
  fi
fi

# --- clone or update ---
if [ -d "$TARGET/.git" ]; then
  say "已存在，改為更新…" "Already present; updating…"
  git -C "$TARGET" fetch --depth 1 origin "$REF"
  git -C "$TARGET" checkout -q FETCH_HEAD
elif [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  # Refuse to clone over someone else's data.
  echo "$TARGET exists and is not a discord-copilot-sdk checkout. Set DISCORD_COPILOT_SDK_DIR elsewhere." >&2
  exit 1
else
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$TARGET"
fi

# --- hand off to the repo's installer ---
[ -f "$TARGET/install.sh" ] || { echo "install.sh not found at $TARGET" >&2; exit 1; }
say "交給安裝器…" "Handing off to the installer…"
# `< /dev/tty` matters: this script's stdin is the curl pipe, so without it the
# installer's prompts (including the hidden password prompt) would read the
# script body instead of the user.
if [ -t 1 ] && [ -r /dev/tty ]; then
  bash "$TARGET/install.sh" "${FORWARD[@]+"${FORWARD[@]}"}" < /dev/tty
else
  bash "$TARGET/install.sh" "${FORWARD[@]+"${FORWARD[@]}"}"
fi

say "完成。原始碼在：$TARGET" "Done. Source is at: $TARGET"

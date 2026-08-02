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
#
# Folder resolution (highest priority first), same as get.ps1:
#   1. --dir <path> / DISCORD_COPILOT_SDK_DIR env var
#   2. Interactive (real tty, no --yes/-y): if the cwd (or an ancestor) is
#      already a discord-copilot-sdk checkout, offer to reuse it, install to
#      the default, or a custom path
#   3. Non-interactive (--yes/-y, or piped with no tty): default
#      ~/discord-copilot-sdk, no prompt — so scripted/CI invocations never
#      depend on the caller's cwd
# Reusing an existing checkout NEVER fetches or checks out — it hands off to
# that directory's install.sh exactly as it stands, because detaching HEAD on
# a clone you are actively developing in would be a correctness bug, not a
# convenience. Prompts read from /dev/tty because stdin here is the curl pipe.
set -euo pipefail

REPO_URL="https://github.com/lettucebo/discord-copilot-sdk.git"
REF="${DISCORD_COPILOT_SDK_REF:-main}"
TARGET="${DISCORD_COPILOT_SDK_DIR:-}"
TARGET_EXPLICIT=0
[ -n "$TARGET" ] && TARGET_EXPLICIT=1
DEFAULT_TARGET="$HOME/discord-copilot-sdk"

case "${LANG:-}" in zh*) ZH=1 ;; *) ZH=0 ;; esac
say() { if [ "$ZH" = "1" ]; then echo "$1"; else echo "$2"; fi; }

# Flags are forwarded verbatim to install.sh; --dir/--ref are consumed here.
# --yes/-y is PEEKED (not consumed) so it also still reaches install.sh.
FORWARD=()
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET="$2"; TARGET_EXPLICIT=1; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --yes|-y) YES=1; FORWARD+=("$1"); shift ;;
    *) FORWARD+=("$1"); shift ;;
  esac
done

say "discord-copilot-sdk 一鍵安裝（網路啟動器）" "discord-copilot-sdk one-line bootstrap"

# --- git --- (must run before folder detection below, which shells out to git)
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

norm() { echo "$1" | sed -e 's/\.git$//' -e 's#/$##' | tr '[:upper:]' '[:lower:]'; }

# Is the CURRENT directory (or an ancestor) already a checkout of THIS repo?
# Prints the toplevel path and returns 0, or returns 1 for "not a repo at all" /
# "no origin" / "origin is something else" — those are all just "no, nothing
# to detect".
find_existing_checkout() {
  local top origin
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || return 1
  origin="$(git -C "$top" remote get-url origin 2>/dev/null || true)"
  [ -n "$origin" ] || return 1
  [ "$(norm "$origin")" = "$(norm "$REPO_URL")" ] || return 1
  echo "$top"
}

# A non-interactive run (scripted, CI, --yes/-y, no tty) must behave the same
# regardless of the caller's cwd — so it never prompts and never auto-reuses a
# directory it merely happens to be standing in. Mirrors the tty check already
# used below for the install.sh handoff.
is_interactive() { [ "$YES" = "0" ] && [ -t 1 ] && [ -r /dev/tty ]; }

# --- resolve target directory ---
# Priority: --dir / DISCORD_COPILOT_SDK_DIR > interactive chooser > non-interactive default.
# Only the interactive "reuse the checkout I'm standing in" choice sets
# REUSE_AS_IS — that is the ONE path that must never fetch/checkout (see below).
REUSE_AS_IS=0
if [ "$TARGET_EXPLICIT" = "0" ]; then
  if is_interactive; then
    if EXISTING="$(find_existing_checkout)"; then
      say "找到現有的 checkout：$EXISTING" "Found an existing checkout: $EXISTING"
      say "  [1] 使用現有的（預設，不會更新）" "  [1] Use it as-is (default, not updated)"
      say "  [2] 安裝到 $DEFAULT_TARGET" "  [2] Install to $DEFAULT_TARGET"
      say "  [3] 自訂路徑" "  [3] Custom path"
      read -r CHOICE < /dev/tty
      case "$CHOICE" in
        2) TARGET="$DEFAULT_TARGET" ;;
        3) read -r TARGET < /dev/tty ;;
        *) TARGET="$EXISTING"; REUSE_AS_IS=1 ;;
      esac
    else
      say "  [1] 安裝到 $DEFAULT_TARGET（預設）" "  [1] Install to $DEFAULT_TARGET (default)"
      say "  [2] 自訂路徑" "  [2] Custom path"
      read -r CHOICE < /dev/tty
      case "$CHOICE" in
        2) read -r TARGET < /dev/tty ;;
        *) TARGET="$DEFAULT_TARGET" ;;
      esac
    fi
    [ -n "$TARGET" ] || { echo "A target directory is required." >&2; exit 1; }
  else
    TARGET="$DEFAULT_TARGET"
  fi
fi

say "  目標目錄：$TARGET" "  Target: $TARGET"
say "  分支/標籤：$REF" "  Ref: $REF"

# --- clone or update ---
if [ "$REUSE_AS_IS" = "1" ]; then
  # Chosen from the menu above: the user was already standing inside this
  # checkout. Never fetch/checkout here — that would detach HEAD out from
  # under a clone someone might be actively developing in (e.g. on `main`).
  say "使用你現有的 checkout（未更新）…" "Using your existing checkout (not updated)…"
elif [ -d "$TARGET/.git" ]; then
  # Being A git repo does not make it OUR git repo: without this the update path
  # would fetch from a stranger's origin and hand off to their install.sh. This
  # branch is reached only for a bootstrap-MANAGED directory (the default,
  # DISCORD_COPILOT_SDK_DIR, --dir, or a menu-typed custom path) — never for the
  # auto-detected "reuse as-is" choice above — so fetch + detach here is
  # expected appliance-style behavior, not a surprise.
  ORIGIN="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  if [ -z "$ORIGIN" ] || [ "$(norm "$ORIGIN")" != "$(norm "$REPO_URL")" ]; then
    echo "$TARGET is a git repo whose origin is '$ORIGIN', not $REPO_URL. Set DISCORD_COPILOT_SDK_DIR elsewhere." >&2
    exit 1
  fi
  say "已存在，改為更新…" "Already present; updating…"
  git -C "$TARGET" fetch --depth 1 origin "$REF"
  git -C "$TARGET" checkout -q --detach FETCH_HEAD
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

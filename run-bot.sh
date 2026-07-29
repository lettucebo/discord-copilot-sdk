#!/usr/bin/env bash
# Start the bot detached, with the same PATH/HOME fixes residency needs.
#
#   ./run-bot.sh              # start (refuses if already running)
#   ./run-bot.sh --foreground # run in this terminal instead
#
# The PID is NOT tracked here: the app writes its own lock at
# ~/.discord-copilot-sdk/<instance>.lock, and a second source of truth could
# disagree with it. stop-bot.sh reads that same lock.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Same rule as the app (src/core/paths.ts): an id the app rejects would make this
# script read a different lock than the app writes, so it would start a second
# process that then dies on the app's own lock.
RAW_ID="$(printf '%s' "${DISCORD_COPILOT_SDK_INSTANCE_ID:-}" | tr -d '[:space:]')"
if printf '%s' "$RAW_ID" | grep -Eq '^[A-Za-z0-9._-]{1,64}$'; then
  INSTANCE="$RAW_ID"
else
  INSTANCE="default"
fi
STATE_DIR="$HOME/.discord-copilot-sdk"
LOCK="$STATE_DIR/$INSTANCE.lock"
FOREGROUND=0
[ "${1:-}" = "--foreground" ] && FOREGROUND=1

if [ -f "$LOCK" ]; then
  EXISTING="$(tr -d '[:space:]' < "$LOCK")"
  if [ -n "$EXISTING" ] && kill -0 "$EXISTING" 2>/dev/null; then
    echo "Already running (PID $EXISTING). Run ./stop-bot.sh first."
    exit 0
  fi
fi

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "Not built yet, running npm run build…"
  (cd "$ROOT" && npm run build)
fi

# Keep this identical to the residency wrapper so "works here, fails there"
# cannot happen.
if command -v copilot >/dev/null 2>&1; then
  PATH="$(dirname "$(command -v copilot)"):$PATH"
  export PATH
fi

mkdir -p "$STATE_DIR/logs"
LOG="$STATE_DIR/logs/run-bot.$INSTANCE.log"

cd "$ROOT"
if [ "$FOREGROUND" = "1" ]; then
  exec node dist/index.js
fi

nohup node dist/index.js >>"$LOG" 2>&1 &
PID=$!
sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  echo "Failed to start, see: $LOG" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 1
fi
echo "Started (PID $PID). Log: $LOG"
echo "Stop: ./stop-bot.sh"

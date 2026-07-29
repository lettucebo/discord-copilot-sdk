#!/usr/bin/env bash
# Stop the bot started by run-bot.sh (or by the residency unit).
#
# Reads the PID from the lock the APP itself writes
# (~/.discord-copilot-sdk/<instance>.lock) rather than keeping a second,
# disagreeable copy.
set -euo pipefail

INSTANCE="${DISCORD_COPILOT_SDK_INSTANCE_ID:-default}"
LOCK="$HOME/.discord-copilot-sdk/$INSTANCE.lock"

if [ ! -f "$LOCK" ]; then
  echo "Not running (no lock file)."
  exit 0
fi

PID="$(tr -d '[:space:]' < "$LOCK")"
case "$PID" in
  ''|*[!0-9]*) echo "Unreadable lock contents: $LOCK"; exit 0 ;;
esac

if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID is already gone (stale lock)."
  exit 0
fi

# Only stop something that is actually our bot — a recycled PID could be anything.
CMD="$(ps -p "$PID" -o comm= 2>/dev/null || true)"
case "$CMD" in
  *node*) ;;
  *) echo "PID $PID is '$CMD', not node — refusing to stop it."; exit 0 ;;
esac

kill "$PID"
echo "Stopped (PID $PID)."

# If residency is installed it would restart the bot; say so rather than leaving
# the operator wondering why it came back.
if command -v systemctl >/dev/null 2>&1 &&
   systemctl --user is-enabled "discord-copilot-sdk-$INSTANCE.service" >/dev/null 2>&1; then
  echo "Note: residency unit 'discord-copilot-sdk-$INSTANCE.service' is enabled and will restart it."
  echo "  systemctl --user stop discord-copilot-sdk-$INSTANCE.service"
fi

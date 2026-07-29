#!/usr/bin/env bash
# Stop the bot started by run-bot.sh (or by the residency unit).
#
# Reads the PID from the lock the APP itself writes
# (~/.discord-copilot-sdk/<instance>.lock) rather than keeping a second,
# disagreeable copy.
#
# If residency is installed the SERVICE MANAGER is the lifecycle authority — the
# unit is Restart=always, so killing only the process makes it come back within
# seconds. The unit is stopped first.
#
#   ./stop-bot.sh            # stop now (unit stays enabled for next boot)
#   ./stop-bot.sh --disable  # also disable the unit, so it stays down
set -euo pipefail

DISABLE=0
[ "${1:-}" = "--disable" ] && DISABLE=1

# Same rule as the app (src/core/paths.ts) and residency.mjs: an id the app
# rejects would make the helpers read a different lock than the app writes.
RAW_ID="$(printf '%s' "${DISCORD_COPILOT_SDK_INSTANCE_ID:-}" | tr -d '[:space:]')"
if printf '%s' "$RAW_ID" | grep -Eq '^[A-Za-z0-9._-]{1,64}$'; then
  INSTANCE="$RAW_ID"
else
  INSTANCE="default"
fi
LOCK="$HOME/.discord-copilot-sdk/$INSTANCE.lock"
UNIT="discord-copilot-sdk-$INSTANCE.service"

# 1) Take the service manager out of the loop first.
if command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$UNIT" >/dev/null 2>&1; then
  systemctl --user stop "$UNIT" || true
  echo "Stopped residency unit: $UNIT"
  if [ "$DISABLE" = "1" ]; then
    systemctl --user disable "$UNIT" || true
    echo "Disabled; it will not start at boot. Re-enable: systemctl --user enable --now $UNIT"
  else
    echo "Unit stays enabled and starts again at boot/login; use --disable to keep it down."
  fi
fi

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

# 2) Prove it is OUR bot. The lock survives a crash, PIDs are reused, and "it is
#    called node" is not identity — a machine can easily have a dozen unrelated
#    node processes. Match the full command line.
ARGS="$(ps -p "$PID" -o args= 2>/dev/null || true)"
case "$ARGS" in
  *index.js*) ;;
  *) echo "PID $PID does not look like this bot — refusing to stop it."; echo "  $ARGS"; exit 0 ;;
esac

kill "$PID"
echo "Stopped (PID $PID)."

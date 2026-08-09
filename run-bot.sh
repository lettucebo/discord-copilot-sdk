#!/usr/bin/env bash
# Start the bot detached, waiting until Discord is fully ready.
#
#   ./run-bot.sh              # start (refuses if already running)
#   ./run-bot.sh --foreground # run in this terminal instead
#
# Detached startup is delegated to scripts/run.mjs. It waits for the app's
# owner lock plus a one-time ready proof, so a process that merely survives a
# short sleep is never reported as started.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOREGROUND=0
[ "${1:-}" = "--foreground" ] && FOREGROUND=1

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

cd "$ROOT"
if [ "$FOREGROUND" = "1" ]; then
  exec node dist/index.js
fi

exec node scripts/run.mjs

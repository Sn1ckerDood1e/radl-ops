#!/bin/bash
# Watcher Health Check — restarts watcher if it crashed
# Designed to run every 5 minutes via cron
#
# Only restarts if:
# 1. Watcher tmux session is NOT running
# 2. The watcher was previously started (state file exists and != "stopped")
#
# This prevents restarting a watcher that was intentionally stopped.

set -euo pipefail

RADL_OPS_DIR="${RADL_OPS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG_DIR="$RADL_OPS_DIR/logs/watcher"
STATE_FILE="$LOG_DIR/.watcher-state"
TMUX_SESSION="radl-watcher"
HEALTH_LOG="/tmp/radl-watcher-health.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$HEALTH_LOG"
}

# If tmux session is running, nothing to do
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  exit 0
fi

# If state file doesn't exist or says "stopped", watcher was intentionally off
state=$(cat "$STATE_FILE" 2>/dev/null || echo "unknown")
if [ "$state" = "stopped" ] || [ "$state" = "unknown" ]; then
  exit 0
fi

# Watcher crashed — restart it
log "Watcher crashed (state was: $state). Restarting..."
"$RADL_OPS_DIR/scripts/watcher.sh" start >> "$HEALTH_LOG" 2>&1

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  log "Watcher restarted successfully."
else
  log "ERROR: Failed to restart watcher."
fi

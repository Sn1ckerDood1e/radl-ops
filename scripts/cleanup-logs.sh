#!/bin/bash
# Clean up usage logs older than 90 days
# Called by cron daily at midnight
#
# Usage: bash /home/hb/radl-ops/scripts/cleanup-logs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(dirname "$SCRIPT_DIR")"

cd "$OPS_DIR" && npx tsx -e "
  import { initTokenTracker, cleanupOldUsageLogs } from './src/models/token-tracker.js';
  initTokenTracker();
  cleanupOldUsageLogs(90);
  console.log('Cleanup complete');
" 2>/dev/null

echo "$(date -Iseconds) Log cleanup complete"

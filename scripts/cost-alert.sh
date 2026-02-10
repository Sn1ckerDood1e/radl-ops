#!/bin/bash
# Check daily API costs and alert via Slack if threshold exceeded
# Called by cron daily at 6pm
#
# Usage: bash /home/hb/radl-ops/scripts/cost-alert.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(dirname "$SCRIPT_DIR")"

RESULT=$(cd "$OPS_DIR" && npx tsx -e "
  import { initTokenTracker, checkCostThreshold } from './src/models/token-tracker.js';
  initTokenTracker();
  const alert = checkCostThreshold();
  console.log(JSON.stringify(alert));
" 2>/dev/null)

LEVEL=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['level'])")
MESSAGE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['message'])")

if [ "$LEVEL" != "ok" ]; then
  "$SCRIPT_DIR/notify.sh" "$MESSAGE"
  echo "$(date -Iseconds) Alert sent: $MESSAGE"
else
  echo "$(date -Iseconds) Costs OK: $MESSAGE"
fi

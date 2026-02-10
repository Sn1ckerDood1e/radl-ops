#!/bin/bash
# Install radl-ops cron jobs
# Run once: bash /home/hb/radl-ops/scripts/cron-setup.sh
#
# Jobs installed:
#   @reboot   - briefing on WSL start
#   midnight  - log cleanup (90-day retention)
#   6pm       - cost alert check

set -euo pipefail

CRONTAB_ENTRIES="# Radl-Ops automated tasks
@reboot sleep 30 && /home/hb/radl-ops/scripts/briefing-on-wake.sh >> /tmp/radl-briefing.log 2>&1
0 0 * * * /home/hb/radl-ops/scripts/cleanup-logs.sh >> /tmp/radl-cleanup.log 2>&1
0 18 * * * /home/hb/radl-ops/scripts/cost-alert.sh >> /tmp/radl-cost-alert.log 2>&1"

# Preserve existing non-radl-ops cron jobs
EXISTING=$(crontab -l 2>/dev/null | grep -v 'radl-ops' | grep -v '^# Radl-Ops' || true)

{
  if [ -n "$EXISTING" ]; then
    echo "$EXISTING"
    echo ""
  fi
  echo "$CRONTAB_ENTRIES"
} | crontab -

echo "Cron jobs installed:"
crontab -l

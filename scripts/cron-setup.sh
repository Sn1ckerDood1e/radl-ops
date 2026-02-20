#!/bin/bash
# Install radl-ops cron jobs
# Run once: bash /home/hb/radl-ops/scripts/cron-setup.sh
#
# Jobs installed:
#   @reboot      - briefing on WSL start
#   7am Mon-Fri  - daily briefing via Gmail
#   7am Saturday - weekly briefing via Gmail
#   midnight     - log cleanup (90-day retention)
#   6pm          - cost alert check
#   every 5m     - critical alert polling (Vercel/Supabase/Sentry → Gmail)

set -euo pipefail

CRONTAB_ENTRIES="# Radl-Ops automated tasks
@reboot sleep 30 && /home/hb/radl-ops/scripts/briefing-on-wake.sh >> /tmp/radl-briefing.log 2>&1
0 7 * * 1-5 /home/hb/radl-ops/scripts/daily-briefing.sh >> /tmp/radl-daily-briefing.log 2>&1
0 7 * * 6 /home/hb/radl-ops/scripts/weekly-briefing.sh >> /tmp/radl-weekly-briefing.log 2>&1
0 0 * * * /home/hb/radl-ops/scripts/cleanup-logs.sh >> /tmp/radl-cleanup.log 2>&1
0 18 * * * /home/hb/radl-ops/scripts/cost-alert.sh >> /tmp/radl-cost-alert.log 2>&1
*/5 * * * * /home/hb/radl-ops/node_modules/.bin/tsx /home/hb/radl-ops/scripts/alert-poll.ts >> /tmp/radl-alert-poll.log 2>&1"

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

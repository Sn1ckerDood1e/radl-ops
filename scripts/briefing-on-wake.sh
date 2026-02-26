#!/bin/bash
# Briefing on Wake - Runs once per day when WSL starts
# Checks if today's briefing already exists before generating

set -e

RADL_OPS_DIR="${RADL_OPS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

# Load nvm — required for cron which doesn't source .bashrc
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

BRIEFING_DIR="$RADL_OPS_DIR/briefings"
DATE=$(date +%Y-%m-%d)
DAY_OF_WEEK=$(date +%u)  # 1=Monday, 6=Saturday, 7=Sunday
LOCK_FILE="/tmp/radl-briefing-$DATE.lock"

# Skip if already ran today
if [ -f "$LOCK_FILE" ]; then
    exit 0
fi

# Create lock file
touch "$LOCK_FILE"

# Skip weekends for daily briefing
if [ "$DAY_OF_WEEK" -eq 7 ]; then
    # Sunday - no briefing
    exit 0
elif [ "$DAY_OF_WEEK" -eq 6 ]; then
    # Saturday - run weekly briefing
    "$RADL_OPS_DIR/scripts/weekly-briefing.sh"
else
    # Monday-Friday - run daily briefing
    "$RADL_OPS_DIR/scripts/daily-briefing.sh"
fi

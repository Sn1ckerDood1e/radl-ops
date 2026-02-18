#!/bin/bash
# Daily Briefing Script - Runs Mon-Fri at 7am
# Generates briefing using Claude Code MCP tools and delivers via Gmail
#
# Usage: bash /home/hb/radl-ops/scripts/daily-briefing.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIEFING_DIR="/home/hb/radl-ops/briefings"
DATE=$(date +%Y-%m-%d)
DAY_NAME=$(date +%A)
BRIEFING_FILE="$BRIEFING_DIR/daily-$DATE.md"

# Ensure briefing directory exists
mkdir -p "$BRIEFING_DIR"

# Change to radl-ops directory for CLAUDE.md context
cd /home/hb/radl-ops

echo "[$DATE] Generating daily briefing with Gmail delivery..."

# Generate and deliver briefing using Claude Code with MCP tools
# The daily_briefing tool generates content via eval-opt loop,
# then deliver_via_gmail sends it through the Google API client.
/home/hb/.nvm/versions/node/v22.22.0/bin/claude -p "
Generate and deliver today's daily briefing for $DAY_NAME, $DATE.

Steps:
1. Enable content tools: mcp__radl-ops__enable_tools({ group: 'content' })
2. Check production health: mcp__radl-ops__production_status({})
3. Generate and send briefing: mcp__radl-ops__daily_briefing({
     deliver_via_gmail: true,
     monitoring_context: '<production status from step 2>'
   })

If Gmail delivery fails, save the briefing markdown to $BRIEFING_FILE instead.
" --max-turns 8 --permission-mode bypassPermissions > "$BRIEFING_FILE" 2>&1

if [ $? -eq 0 ]; then
    echo "[$DATE] Briefing generated and delivered via Gmail"
else
    echo "[$DATE] WARNING: Briefing generation may have failed, check $BRIEFING_FILE"
fi

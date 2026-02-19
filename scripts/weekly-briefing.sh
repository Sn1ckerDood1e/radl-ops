#!/bin/bash
# Weekly Briefing Script - Runs Saturday at 7am
# Generates comprehensive weekly summary and delivers via Gmail
#
# Uses Claude Code to call the weekly_briefing MCP tool with Gmail delivery.
# The MCP tool handles eval-opt quality loop (Haiku generates, Sonnet evaluates).
#
# Usage: bash /home/hb/radl-ops/scripts/weekly-briefing.sh

set -e

BRIEFING_DIR="/home/hb/radl-ops/briefings"
DATE=$(date +%Y-%m-%d)
WEEK_START=$(date -d "6 days ago" +%Y-%m-%d)
BRIEFING_FILE="$BRIEFING_DIR/weekly-$DATE.md"
LOG_FILE="$BRIEFING_DIR/weekly-$DATE.log"

# Ensure briefing directory exists
mkdir -p "$BRIEFING_DIR"

# Resolve Claude CLI path dynamically
NODE_VERSION=$(node -v 2>/dev/null)
NVM_CLAUDE="$HOME/.nvm/versions/node/${NODE_VERSION}/bin/claude"
if command -v claude &>/dev/null; then
    CLAUDE_BIN="claude"
elif [ -n "$NODE_VERSION" ] && [ -x "$NVM_CLAUDE" ]; then
    CLAUDE_BIN="$NVM_CLAUDE"
else
    CLAUDE_BIN="/home/hb/.nvm/versions/node/v22.22.0/bin/claude"
fi

# Change to radl-ops directory for CLAUDE.md context
cd /home/hb/radl-ops

echo "[$DATE] Generating weekly briefing ($WEEK_START to $DATE) with Gmail delivery..."

# Generate and deliver briefing using Claude Code with MCP tools
set +e
$CLAUDE_BIN -p "
Generate and deliver the weekly briefing for the week of $WEEK_START to $DATE.

Steps:
1. Enable content tools: mcp__radl-ops__enable_tools({ group: 'content' })
2. Check production health: mcp__radl-ops__production_status({})
3. Generate and send briefing: mcp__radl-ops__weekly_briefing({
     deliver_via_gmail: true,
     week_start: '$WEEK_START',
     monitoring_context: '<production status from step 2>'
   })

If Gmail delivery fails, output the briefing markdown so it gets saved to the log file.
" --max-turns 12 --permission-mode bypassPermissions > "$LOG_FILE" 2>&1
EXIT_CODE=$?
set -e

# Save a copy of the briefing output
cp "$LOG_FILE" "$BRIEFING_FILE" 2>/dev/null || true

if [ $EXIT_CODE -eq 0 ]; then
    echo "[$DATE] Weekly briefing complete (exit 0). Check $LOG_FILE for Gmail delivery status."
else
    echo "[$DATE] WARNING: Weekly briefing failed (exit $EXIT_CODE), check $LOG_FILE"
fi

# Clean up old briefings (keep 30 days)
find "$BRIEFING_DIR" -name "weekly-*.md" -mtime +30 -delete 2>/dev/null || true
find "$BRIEFING_DIR" -name "weekly-*.log" -mtime +30 -delete 2>/dev/null || true

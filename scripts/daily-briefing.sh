#!/bin/bash
# Daily Briefing Script - Runs Mon-Fri at 7am
# Generates briefing using Claude Code and emails to configured address

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

echo "[$DATE] Generating daily briefing..."

# Generate briefing using Claude Code
# Using local files only (MCP tools are slow in non-interactive mode)
/home/hb/.nvm/versions/node/v22.22.0/bin/claude -p "
Generate a daily briefing for $DAY_NAME, $DATE.

Read these files:
- /home/hb/radl/.planning/STATE.md (current position)
- /home/hb/radl/.planning/ROADMAP.md (what's next)

Format:
📍 CURRENT POSITION
- [Milestone, Phase from STATE.md]
- [Last Sprint completed]

🎯 TODAY'S SPRINT
Based on STATE.md 'Next Sprint' field or next phase task:
- [Specific feature or task to sprint on]

🔧 COMMAND
/build \"[feature]\"

📱 SOCIAL IDEA
- One content idea (product demo or rowing humor)

Keep under 150 words. Be direct.
" --max-turns 5 --permission-mode bypassPermissions > "$BRIEFING_FILE" 2>&1

# Check if briefing was generated
if [ -s "$BRIEFING_FILE" ]; then
    echo "[$DATE] Briefing generated: $BRIEFING_FILE"

    # Send to Slack (dedicated briefings channel)
    source /home/hb/radl-ops/.env
    WEBHOOK="${SLACK_BRIEFING_WEBHOOK:-$SLACK_WEBHOOK_URL}"
    if [ -n "$WEBHOOK" ]; then
        BRIEFING_CONTENT=$(cat "$BRIEFING_FILE" | head -c 2500)
        cat << EOF | curl -s -X POST "$WEBHOOK" -H "Content-Type: application/json" -d @-
{
  "blocks": [
    {
      "type": "header",
      "text": {"type": "plain_text", "text": "📋 Daily Briefing - $DAY_NAME"}
    },
    {
      "type": "section",
      "text": {"type": "mrkdwn", "text": "$(echo "$BRIEFING_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ' | sed 's/  / /g')"}
    }
  ]
}
EOF
        echo "[$DATE] Briefing sent to Slack"
    fi
else
    echo "[$DATE] ERROR: Briefing generation failed"
    exit 1
fi

#!/bin/bash
# Weekly Briefing Script - Runs Saturday at 7am
# Generates comprehensive weekly summary and sends via configured channel

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIEFING_DIR="/home/hb/radl-ops/briefings"
DATE=$(date +%Y-%m-%d)
WEEK_START=$(date -d "6 days ago" +%Y-%m-%d)
BRIEFING_FILE="$BRIEFING_DIR/weekly-$DATE.md"

# Ensure briefing directory exists
mkdir -p "$BRIEFING_DIR"

# Change to radl-ops directory for CLAUDE.md context
cd /home/hb/radl-ops

echo "[$DATE] Generating weekly briefing..."

# Generate briefing using Claude Code
# Simplified for non-interactive mode (MCP tools are slow)
/home/hb/.nvm/versions/node/v22.22.0/bin/claude -p "
Generate a weekly briefing for the week of $WEEK_START to $DATE.

Read these files:
- /home/hb/radl/.planning/STATE.md (current position and sprint log)
- /home/hb/radl/.planning/ROADMAP.md (milestones and phases)

Format:
📈 WEEK IN REVIEW
- Sprints completed (from STATE.md sprint log)
- Features shipped
- Any blockers hit?

📊 MILESTONE PROGRESS
- v4.0: X/11 phases complete
- Current phase focus

🎯 NEXT WEEK SPRINTS
List 3-5 specific features to sprint on:
1. [Feature] - Phase X
2. [Feature] - Phase X
...

💡 BLUE OCEAN SPOTLIGHT
- Highlight one unique feature from phases 52-59
- Why it differentiates from CrewLab/iCrew

📱 SOCIAL CALENDAR (Mon-Fri)
- Monday: [product demo idea]
- Tuesday: [rowing humor]
- Wednesday: [feature preview]
- Thursday: [customer story angle]
- Friday: [behind the scenes]

🏆 WIN OF THE WEEK
- Something to celebrate

Keep under 350 words.
" --max-turns 8 --permission-mode bypassPermissions > "$BRIEFING_FILE" 2>&1

# Check if briefing was generated
if [ -s "$BRIEFING_FILE" ]; then
    echo "[$DATE] Weekly briefing generated: $BRIEFING_FILE"

    # Send to Slack (dedicated briefings channel)
    source /home/hb/radl-ops/.env
    WEBHOOK="${SLACK_BRIEFING_WEBHOOK:-$SLACK_WEBHOOK_URL}"
    if [ -n "$WEBHOOK" ]; then
        BRIEFING_CONTENT=$(cat "$BRIEFING_FILE" | head -c 2800)
        cat << EOF | curl -s -X POST "$WEBHOOK" -H "Content-Type: application/json" -d @-
{
  "blocks": [
    {
      "type": "header",
      "text": {"type": "plain_text", "text": "📊 Weekly Briefing - Week of $WEEK_START"}
    },
    {
      "type": "section",
      "text": {"type": "mrkdwn", "text": "$(echo "$BRIEFING_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ' | sed 's/  / /g')"}
    }
  ]
}
EOF
        echo "[$DATE] Weekly briefing sent to Slack"
    fi
else
    echo "[$DATE] ERROR: Weekly briefing generation failed"
    exit 1
fi

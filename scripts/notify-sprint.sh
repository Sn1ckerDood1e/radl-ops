#!/bin/bash
# Send sprint completion notification to Slack
# Usage: ./notify-sprint.sh "Phase 53.1" "Rigging Database" "commit_hash" "1.5 hours"

set -e

PHASE="$1"
TITLE="$2"
COMMIT="$3"
TIME="$4"
DETAILS="$5"

if [ -z "$PHASE" ] || [ -z "$TITLE" ]; then
  echo "Usage: ./notify-sprint.sh <phase> <title> [commit] [time] [details]"
  exit 1
fi

# Load webhook from .env
WEBHOOK_URL="${SLACK_WEBHOOK_URL:-$(grep SLACK_WEBHOOK_URL /home/hb/radl-ops/.env | cut -d'=' -f2)}"

if [ -z "$WEBHOOK_URL" ]; then
  echo "Error: SLACK_WEBHOOK_URL not found"
  exit 1
fi

# Build the message
COMMIT_LINE=""
if [ -n "$COMMIT" ]; then
  COMMIT_LINE="*Commit:* \`$COMMIT\`\n"
fi

TIME_LINE=""
if [ -n "$TIME" ]; then
  TIME_LINE="*Time:* $TIME"
fi

DETAILS_LINE=""
if [ -n "$DETAILS" ]; then
  DETAILS_LINE="\n\n$DETAILS"
fi

curl -s -X POST -H 'Content-type: application/json' --data "{
  \"text\": \"✅ Sprint Complete: $PHASE - $TITLE\",
  \"blocks\": [
    {
      \"type\": \"header\",
      \"text\": {
        \"type\": \"plain_text\",
        \"text\": \"✅ Sprint Complete\",
        \"emoji\": true
      }
    },
    {
      \"type\": \"section\",
      \"text\": {
        \"type\": \"mrkdwn\",
        \"text\": \"*$PHASE: $TITLE*$DETAILS_LINE\n\n$COMMIT_LINE$TIME_LINE\"
      }
    },
    {
      \"type\": \"context\",
      \"elements\": [
        {
          \"type\": \"mrkdwn\",
          \"text\": \"Deployed to production via Vercel • $(date '+%Y-%m-%d %H:%M')\"
        }
      ]
    }
  ]
}" "$WEBHOOK_URL"

echo ""
echo "Slack notification sent."

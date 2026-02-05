#!/bin/bash
# Send notification to Slack
# Usage: ./notify.sh "Your message here"

set -e

source /home/hb/radl-ops/.env

MESSAGE="$1"

if [ -z "$MESSAGE" ]; then
    echo "Usage: ./notify.sh \"Your message\""
    exit 1
fi

if [ -z "$SLACK_WEBHOOK_URL" ]; then
    echo "SLACK_WEBHOOK_URL not set in .env"
    exit 1
fi

# Send to Slack
RESPONSE=$(cat << EOF | curl -s -X POST "$SLACK_WEBHOOK_URL" -H "Content-Type: application/json" -d @-
{"text": "$MESSAGE"}
EOF
)

if [ "$RESPONSE" = "ok" ]; then
    echo "Notification sent"
else
    echo "Failed: $RESPONSE"
    exit 1
fi

#!/bin/bash
# Send email via Resend API
# Usage: ./send-email.sh "Subject" "body text or file path"

set -e

# Load environment variables
source /home/hb/radl-ops/.env

SUBJECT="$1"
BODY_INPUT="$2"

# Check if body is a file or direct text
if [ -f "$BODY_INPUT" ]; then
    BODY=$(cat "$BODY_INPUT")
else
    BODY="$BODY_INPUT"
fi

# Escape the body for JSON using Python (more reliable than sed)
BODY_ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$BODY")

# Send via Resend API
RESPONSE=$(curl -s -X POST 'https://api.resend.com/emails' \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{
    \"from\": \"Radl Ops <onboarding@resend.dev>\",
    \"to\": \"$BRIEFING_EMAIL\",
    \"subject\": \"$SUBJECT\",
    \"text\": $BODY_ESCAPED
  }")

# Check response
if echo "$RESPONSE" | grep -q '"id"'; then
    EMAIL_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    echo "Email sent successfully. ID: $EMAIL_ID"
else
    echo "Email failed: $RESPONSE"
    exit 1
fi

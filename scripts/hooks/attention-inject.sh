#!/bin/bash
# Claude Code PreToolUse (Bash) hook — Attention injection
#
# Every 15th Bash tool call, emits a reminder of the current sprint goal
# to prevent drift and rabbit holes.

# Only run in radl contexts
case "$PWD" in
  /home/hb|/home/hb/radl|/home/hb/radl/*|/home/hb/radl-ops|/home/hb/radl-ops/*)
    ;;
  *)
    exit 0
    ;;
esac

COUNTER_FILE="/tmp/claude-bash-call-count"
SPRINT_FILE="/home/hb/radl/.planning/sprints/current.json"

# Increment counter
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
  COUNT=$((COUNT + 1))
else
  COUNT=1
fi

echo "$COUNT" > "$COUNTER_FILE"

# Every 15th call, remind of sprint goal
if [ $((COUNT % 15)) -eq 0 ] && [ -f "$SPRINT_FILE" ]; then
  TITLE=$(python3 -c "
import json
with open('$SPRINT_FILE') as f:
    d = json.load(f)
    status = d.get('status', '')
    if status in ('active', 'in_progress'):
        print(f\"{d.get('phase', '?')} — {d.get('title', '?')}\")
" 2>/dev/null)

  if [ -n "$TITLE" ]; then
    echo "SPRINT FOCUS: $TITLE — Stay on task."
  fi
fi

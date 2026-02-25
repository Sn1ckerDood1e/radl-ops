#!/bin/bash
# Claude Code Stop hook for Radl Ops
# Reminds the agent to wrap up properly before the session ends.

RADL_DIR="/home/hb/radl"
SPRINT_DIR="$RADL_DIR/.planning/sprints"

# Only run if we're in the radl project or home directory
case "$PWD" in
  /home/hb|/home/hb/radl|/home/hb/radl/*|/home/hb/radl-ops|/home/hb/radl-ops/*)
    ;;
  *)
    exit 0
    ;;
esac

echo "=== RADL OPS SESSION END CHECKLIST ==="
echo ""

# Check if STATE.md was recently modified (within last 2 hours)
STATE_FILE="$RADL_DIR/.planning/STATE.md"
if [ -f "$STATE_FILE" ]; then
  STATE_AGE=$(python3 -c "
import os, time
mtime = os.path.getmtime('$STATE_FILE')
hours = (time.time() - mtime) / 3600
print(f'{hours:.1f}')
" 2>/dev/null || echo "999")

  if python3 -c "exit(0 if float('$STATE_AGE') > 2 else 1)" 2>/dev/null; then
    echo "WARNING: STATE.md not updated in ${STATE_AGE}h — update it now!"
  else
    echo "STATE.md: Updated recently"
  fi
else
  echo "WARNING: STATE.md not found!"
fi

# Check sprint state
if [ -f "$SPRINT_DIR/current.json" ]; then
  STATUS=$(python3 -c "
import json
with open('$SPRINT_DIR/current.json') as f:
    print(json.load(f).get('status', 'unknown'))
" 2>/dev/null || echo "unknown")

  if [ "$STATUS" = "active" ] || [ "$STATUS" = "in_progress" ]; then
    echo "SPRINT: Still active — run sprint_complete or sprint checkpoint"
  fi
fi

# Session metrics summary
echo ""
echo "SESSION METRICS:"

# Tool call count (from context-awareness counter)
TOOL_COUNT_FILE="/tmp/claude-tool-call-count"
if [ -f "$TOOL_COUNT_FILE" ]; then
  TOOL_COUNT=$(cat "$TOOL_COUNT_FILE" 2>/dev/null || echo "0")
  echo "  Tool calls: $TOOL_COUNT"
fi

# Bash call count (from attention-inject counter)
BASH_COUNT_FILE="/tmp/claude-bash-call-count"
if [ -f "$BASH_COUNT_FILE" ]; then
  BASH_COUNT=$(cat "$BASH_COUNT_FILE" 2>/dev/null || echo "0")
  echo "  Bash calls: $BASH_COUNT"
fi

# Session duration estimate (from counter file timestamps)
if [ -f "$TOOL_COUNT_FILE" ]; then
  CREATED=$(stat -c '%Y' "$TOOL_COUNT_FILE" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  if [ "$CREATED" -gt 0 ]; then
    DURATION=$(( (NOW - CREATED) / 60 ))
    echo "  Session duration: ~${DURATION}min"
  fi
fi

# Commit count in this session (commits since branch diverged from main)
BRANCH=$(git -C /home/hb/radl rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
  COMMIT_COUNT=$(git -C /home/hb/radl rev-list --count main.."$BRANCH" 2>/dev/null || echo "0")
  echo "  Commits on branch: $COMMIT_COUNT"
fi

# Clean up counter files
rm -f "$TOOL_COUNT_FILE" "$BASH_COUNT_FILE" 2>/dev/null

echo ""
echo "END-OF-SESSION TASKS:"
echo "  [ ] Run session_health for session diagnostic report"
echo "  [ ] Update STATE.md with what was done"
echo "  [ ] Commit and push feature branch"
echo "  [ ] Learnings auto-extracted by sprint_complete"
echo ""
echo "=== END SESSION CHECKLIST ==="

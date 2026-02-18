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

echo ""
echo "END-OF-SESSION TASKS:"
echo "  [ ] Run session_health for session diagnostic report"
echo "  [ ] Update STATE.md with what was done"
echo "  [ ] Commit and push feature branch"
echo "  [ ] Run compound.sh extract (if sprint completed)"
echo ""
echo "=== END SESSION CHECKLIST ==="

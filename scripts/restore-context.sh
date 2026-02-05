#!/bin/bash
# Context Restoration Script
# Generates a summary for Claude to restore context after a session reset
# Usage: ./restore-context.sh

set -e

SPRINT_DIR="/home/hb/radl/.planning/sprints"
CURRENT_SPRINT="$SPRINT_DIR/current.json"
RADL_DIR="/home/hb/radl"

echo "=== CONTEXT RESTORATION SUMMARY ==="
echo "Generated: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- Current Sprint Status ---
echo "## Current Sprint"
if [ -f "$CURRENT_SPRINT" ]; then
  python3 << 'EOF'
import json
from datetime import datetime

with open('/home/hb/radl/.planning/sprints/current.json', 'r') as f:
    data = json.load(f)

print(f"Phase: {data.get('phase', 'Unknown')}")
print(f"Title: {data.get('title', 'Unknown')}")
print(f"Estimate: {data.get('estimate', 'Unknown')}")
print(f"Started: {data.get('startTime', 'Unknown')}")
print(f"Status: {data.get('status', 'Unknown')}")
print("")

completed = data.get('completedTasks', [])
print(f"### Completed Tasks ({len(completed)})")
for t in completed:
    print(f"  ✅ {t.get('message', 'Unknown')}")
print("")

blockers = [b for b in data.get('blockers', []) if not b.get('resolved', False)]
print(f"### Active Blockers ({len(blockers)})")
if blockers:
    for b in blockers:
        print(f"  ❌ {b.get('description', 'Unknown')}")
else:
    print("  None")
print("")

checkpoints = data.get('checkpoints', [])
if checkpoints:
    latest = checkpoints[-1]
    print(f"### Latest Checkpoint")
    print(f"  Time: {latest.get('time', 'Unknown')}")
    print(f"  Tasks at checkpoint: {latest.get('completedTasks', 0)}")
EOF
else
  echo "No active sprint."
fi
echo ""

# --- Project State ---
echo "## Project State"
if [ -f "$RADL_DIR/.planning/STATE.md" ]; then
  echo "From STATE.md:"
  grep -E "^\| (Mode|Milestone|Phase|Sprint)" "$RADL_DIR/.planning/STATE.md" | head -10 || echo "  Unable to parse"
else
  echo "STATE.md not found"
fi
echo ""

# --- Recent Git Activity ---
echo "## Recent Git Activity (radl)"
cd "$RADL_DIR" 2>/dev/null && git log --oneline -5 2>/dev/null || echo "Unable to read git log"
echo ""

# --- Recent Checkpoints ---
echo "## Available Checkpoints"
ls -lt "$SPRINT_DIR"/checkpoint-*.json 2>/dev/null | head -5 | while read line; do
  file=$(echo "$line" | awk '{print $NF}')
  if [ -f "$file" ]; then
    time=$(python3 -c "import json; print(json.load(open('$file')).get('checkpoints', [{}])[-1].get('time', 'Unknown'))" 2>/dev/null || echo "Unknown")
    echo "  - $(basename $file) @ $time"
  fi
done || echo "  No checkpoints found"
echo ""

# --- Instructions for Claude ---
echo "## Instructions"
echo "1. Review the current sprint status above"
echo "2. Check the latest checkpoint if context was lost mid-task"
echo "3. Use 'sprint.sh status' for live status"
echo "4. Use 'sprint.sh progress \"message\"' to continue logging work"
echo "5. If blocked, use 'sprint.sh blocker \"description\"'"
echo ""
echo "=== END CONTEXT RESTORATION ==="

#!/bin/bash
# Claude Code SessionStart hook for Radl Ops
# Outputs workflow reminders that get injected into the session context.
# Runs automatically at the start of every Claude Code session.

RADL_DIR="/home/hb/radl"
SPRINT_DIR="$RADL_DIR/.planning/sprints"
KNOWLEDGE_DIR="/home/hb/radl-ops/knowledge"

# Only run if we're in the radl project or home directory
case "$PWD" in
  /home/hb|/home/hb/radl|/home/hb/radl/*|/home/hb/radl-ops|/home/hb/radl-ops/*)
    ;;
  *)
    exit 0
    ;;
esac

echo "=== RADL OPS SESSION START ==="
echo ""

# 1. Branch check
if [ -d "$RADL_DIR/.git" ]; then
  BRANCH=$(cd "$RADL_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
  if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
    echo "BRANCH: $BRANCH — CREATE A FEATURE BRANCH before making changes!"
    echo "  git checkout -b feat/<scope>"
  else
    echo "BRANCH: $BRANCH"
  fi
  echo ""
fi

# 2. Sprint state
if [ -f "$SPRINT_DIR/current.json" ]; then
  python3 -c "
import json
with open('$SPRINT_DIR/current.json') as f:
    d = json.load(f)
status = d.get('status', 'unknown')
phase = d.get('phase', '?')
title = d.get('title', '?')
tasks = len(d.get('completedTasks', []))
print(f'SPRINT: {phase} — {title} ({status}, {tasks} tasks done)')
" 2>/dev/null || echo "SPRINT: No active sprint"
else
  echo "SPRINT: None active — run sprint_start before working"
fi
echo ""

# 3. Key patterns to apply (from knowledge base)
if [ -f "$KNOWLEDGE_DIR/patterns.json" ]; then
  python3 -c "
import json
with open('$KNOWLEDGE_DIR/patterns.json') as f:
    patterns = json.load(f).get('patterns', [])
if patterns:
    print('PATTERNS TO APPLY:')
    for p in patterns:
        print(f'  - {p[\"name\"]}: {p[\"description\"]}')
" 2>/dev/null
  echo ""
fi

# 4. Workflow reminders
echo "WORKFLOW:"
echo "  1. Create feature branch (if on main)"
echo "  2. Start sprint tracking: sprint_start"
echo "  3. Code → typecheck → commit to feature branch"
echo "  4. Code review + security review before PR"
echo "  5. Update STATE.md at session end"
echo ""
echo "=== END SESSION START ==="

#!/bin/bash
# Claude Code SessionStart hook — compact context
# Outputs stripped-down context after compaction.
# Triggered on SessionStart with "compact" argument or after context compaction.

RADL_DIR="/home/hb/radl"
SPRINT_DIR="$RADL_DIR/.planning/sprints"
KNOWLEDGE_DIR="/home/hb/radl-ops/knowledge"

# Only run in radl contexts
case "$PWD" in
  /home/hb|/home/hb/radl|/home/hb/radl/*|/home/hb/radl-ops|/home/hb/radl-ops/*)
    ;;
  *)
    exit 0
    ;;
esac

echo "=== RADL OPS — COMPACT CONTEXT ==="
echo ""

# 1. Current branch
if [ -d "$RADL_DIR/.git" ]; then
  BRANCH=$(cd "$RADL_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
  if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
    echo "BRANCH: $BRANCH — WARNING: Create feature branch first!"
  else
    echo "BRANCH: $BRANCH"
  fi
fi

# 2. Sprint phase + title + status
if [ -f "$SPRINT_DIR/current.json" ]; then
  python3 -c "
import json
with open('$SPRINT_DIR/current.json') as f:
    d = json.load(f)
phase = d.get('phase', '?')
title = d.get('title', '?')
status = d.get('status', 'unknown')
tasks = len(d.get('completedTasks', []))
print(f'SPRINT: {phase} — {title} ({status}, {tasks} done)')
" 2>/dev/null || echo "SPRINT: Error reading state"
else
  echo "SPRINT: None active"
fi

# 3. Top 3 patterns
if [ -f "$KNOWLEDGE_DIR/patterns.json" ]; then
  python3 -c "
import json
with open('$KNOWLEDGE_DIR/patterns.json') as f:
    patterns = json.load(f).get('patterns', [])
top = patterns[:3]
if top:
    print('TOP PATTERNS:')
    for p in top:
        print(f'  - {p[\"name\"]}: {p[\"description\"][:80]}')
" 2>/dev/null
fi

# 4. Current task ID (from sprint)
if [ -f "$SPRINT_DIR/current.json" ]; then
  python3 -c "
import json
with open('$SPRINT_DIR/current.json') as f:
    d = json.load(f)
tasks = d.get('tasks', [])
active = [t for t in tasks if t.get('status') == 'in_progress']
if active:
    print(f'ACTIVE TASK: {active[0].get(\"id\", \"?\")} — {active[0].get(\"title\", \"?\")}')
" 2>/dev/null
fi

echo ""

# 5. Iron laws (brief)
echo "IRON LAWS: No push main | No delete prod | No secrets | 3-strike stop | No modify CI/CD | No force push"
echo ""
echo "=== END COMPACT CONTEXT ==="

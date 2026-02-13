#!/bin/bash
# Claude Code SessionStart hook — full context restore
# Outputs comprehensive session context for the agent.
# Replaces basic session-start.sh with deeper knowledge base integration.
# Runs automatically at the start of every Claude Code session.

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

echo "=== RADL OPS — FULL CONTEXT RESTORE ==="
echo ""

# ─── 1. Branch check ───────────────────────────────────────────────────────────

if [ -d "$RADL_DIR/.git" ]; then
  BRANCH=$(cd "$RADL_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
  if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
    echo "BRANCH: $BRANCH"
    echo "  WARNING: You are on $BRANCH — CREATE A FEATURE BRANCH before making changes!"
    echo "  git checkout -b feat/<scope>"
  else
    echo "BRANCH: $BRANCH"
  fi
  echo ""
fi

# ─── 2. Sprint state ───────────────────────────────────────────────────────────

if [ -f "$SPRINT_DIR/current.json" ]; then
  python3 -c "
import json
with open('$SPRINT_DIR/current.json') as f:
    d = json.load(f)
status = d.get('status', 'unknown')
phase = d.get('phase', '?')
title = d.get('title', '?')
estimate = d.get('estimate', '?')
completed = d.get('completedTasks', [])
blockers = d.get('blockers', [])
print(f'SPRINT: {phase} — {title}')
print(f'  Status: {status} | Estimate: {estimate} | Tasks done: {len(completed)}')
if blockers:
    print(f'  Blockers: {len(blockers)}')
    for b in blockers[-3:]:
        print(f'    - {b.get(\"description\", b) if isinstance(b, dict) else b}')
" 2>/dev/null || echo "SPRINT: Error reading current.json"
else
  echo "SPRINT: None active — run sprint_start before working"
fi
echo ""

# ─── 3. Active patterns from knowledge base ────────────────────────────────────

if [ -f "$KNOWLEDGE_DIR/patterns.json" ]; then
  python3 -c "
import json
with open('$KNOWLEDGE_DIR/patterns.json') as f:
    patterns = json.load(f).get('patterns', [])
if patterns:
    print('ACTIVE PATTERNS:')
    for p in patterns:
        name = p.get('name', '?')
        desc = p.get('description', '')
        cat = p.get('category', '')
        print(f'  [{cat}] {name}: {desc}')
else:
    print('PATTERNS: None loaded')
" 2>/dev/null
  echo ""
fi

# ─── 4. Recent lessons ─────────────────────────────────────────────────────────

if [ -f "$KNOWLEDGE_DIR/lessons.json" ]; then
  python3 -c "
import json
with open('$KNOWLEDGE_DIR/lessons.json') as f:
    lessons = json.load(f).get('lessons', [])
recent = lessons[-5:] if len(lessons) > 5 else lessons
if recent:
    print('RECENT LESSONS (last 5):')
    for l in recent:
        sit = l.get('situation', '?')
        learn = l.get('learning', '')
        print(f'  - {sit}')
        print(f'    -> {learn[:120]}')
else:
    print('LESSONS: None recorded')
" 2>/dev/null
  echo ""
fi

# ─── 5. Deferred items ─────────────────────────────────────────────────────────

if [ -f "$KNOWLEDGE_DIR/deferred.json" ]; then
  python3 -c "
import json
with open('$KNOWLEDGE_DIR/deferred.json') as f:
    items = json.load(f).get('items', [])
unresolved = [i for i in items if not i.get('resolved', False)]
resolved = [i for i in items if i.get('resolved', False)]
print(f'DEFERRED ITEMS: {len(unresolved)} unresolved, {len(resolved)} resolved')
if unresolved:
    for i in unresolved[-5:]:
        effort = i.get('effort', '?')
        title = i.get('title', '?')
        phase = i.get('sprintPhase', '?')
        print(f'  [{effort}] {title} (from {phase})')
" 2>/dev/null
  echo ""
fi

# ─── 6. Estimation calibration ─────────────────────────────────────────────────

echo "ESTIMATION: Actual time runs ~50% of estimated. Halve initial estimates."
echo ""

# ─── 7. Workflow checklist ──────────────────────────────────────────────────────

echo "WORKFLOW CHECKLIST:"
echo "  1. Create feature branch (if on main)"
echo "  2. Start sprint: sprint_start MCP tool"
echo "  3. Research external APIs with context7 BEFORE integration code"
echo "  4. Code -> typecheck -> commit to feature branch"
echo "  5. sprint_progress MCP tool after each commit"
echo "  6. Background review after tasks with NEW patterns"
echo "  7. BOTH code-reviewer + security-reviewer before PR"
echo "  8. sprint_complete MCP tool -> compound_extract"
echo "  9. Update STATE.md at session end"
echo ""

echo "IRON LAWS: No push to main | No delete prod data | No commit secrets | 3-strike stop | No modify CI/CD | No force push"
echo ""
echo "=== END FULL CONTEXT RESTORE ==="

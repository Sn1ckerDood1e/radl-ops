#!/bin/bash
# Claude Code SessionStart hook — full context restore
# Outputs comprehensive session context for the agent.
# Attention-optimized ordering: critical info at top & bottom (U-shaped attention curve).
# Phase-aware sections show different knowledge based on sprint phase.
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

# ═══════════════════════════════════════════════════════════════════════════════
# TOP — Highest attention zone
# ═══════════════════════════════════════════════════════════════════════════════

# ─── 1. Iron laws (top placement for maximum attention) ───────────────────────

echo "IRON LAWS: No push to main | No delete prod data | No commit secrets | 3-strike stop | No modify CI/CD | No force push"
echo ""

# ─── 2. Branch check ─────────────────────────────────────────────────────────

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

# ─── 3. Sprint state ─────────────────────────────────────────────────────────

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

# ═══════════════════════════════════════════════════════════════════════════════
# MIDDLE — Phase-aware sections
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Phase detection ──────────────────────────────────────────────────────────

PHASE="implementation"  # default
if [ -f "$SPRINT_DIR/current.json" ]; then
  PHASE=$(python3 -c "
import json
with open('$SPRINT_DIR/current.json') as f:
    status = json.load(f).get('status', 'unknown').lower()
if 'planning' in status or 'plan' in status:
    print('planning')
elif 'review' in status or 'complete' in status:
    print('review')
else:
    print('implementation')
" 2>/dev/null || echo "implementation")
else
  PHASE="planning"  # No active sprint means planning mode
fi

echo "PHASE: $PHASE"
echo ""

# ─── Helper functions ─────────────────────────────────────────────────────────

show_patterns() {
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
}

show_antibodies() {
  if [ -f "$KNOWLEDGE_DIR/antibodies.json" ]; then
    python3 -c "
import json
with open('$KNOWLEDGE_DIR/antibodies.json') as f:
    antibodies = json.load(f).get('antibodies', [])
active = [a for a in antibodies if a.get('active', True)]
if active:
    print('ACTIVE ANTIBODIES:')
    for a in active:
        trigger = a.get('trigger', '?')
        check = a.get('check', '')
        catches = a.get('catches', 0)
        print(f'  [{catches} catches] {trigger}: {check}')
" 2>/dev/null
    echo ""
  fi
}

show_crystallized() {
  if [ -f "$KNOWLEDGE_DIR/crystallized.json" ]; then
    python3 -c "
import json
with open('$KNOWLEDGE_DIR/crystallized.json') as f:
    checks = json.load(f).get('checks', [])
active = [c for c in checks if c.get('status') == 'active']
if active:
    print('CRYSTALLIZED CHECKS:')
    for c in active:
        trigger = c.get('trigger', '?')
        check = c.get('check', '')
        catches = c.get('catches', 0)
        print(f'  [{catches} catches] {trigger}: {check}')
" 2>/dev/null
    echo ""
  fi
}

show_lessons() {
  local LIMIT=$1
  if [ -f "$KNOWLEDGE_DIR/lessons.json" ]; then
    python3 -c "
import json
limit = $LIMIT
with open('$KNOWLEDGE_DIR/lessons.json') as f:
    lessons = json.load(f).get('lessons', [])
recent = lessons[-limit:] if len(lessons) > limit else lessons
if recent:
    print(f'RECENT LESSONS (last {len(recent)}):')
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
}

show_deferred() {
  local LIMIT=$1
  if [ -f "$KNOWLEDGE_DIR/deferred.json" ]; then
    python3 -c "
import json
limit = $LIMIT
with open('$KNOWLEDGE_DIR/deferred.json') as f:
    items = json.load(f).get('items', [])
unresolved = [i for i in items if not i.get('resolved', False)]
resolved = [i for i in items if i.get('resolved', False)]
print(f'DEFERRED ITEMS: {len(unresolved)} unresolved, {len(resolved)} resolved')
if unresolved:
    shown = unresolved[-limit:] if limit > 0 else unresolved
    for i in shown:
        effort = i.get('effort', '?')
        title = i.get('title', '?')
        phase = i.get('sprintPhase', '?')
        print(f'  [{effort}] {title} (from {phase})')
" 2>/dev/null
    echo ""
  fi
}

show_estimation() {
  echo "ESTIMATION: Actual time runs ~50% of estimated. Halve initial estimates."
  echo ""
}

# ─── Phase-specific content ───────────────────────────────────────────────────

if [ "$PHASE" = "planning" ]; then
  # PLANNING: Full deferred list, estimation, full lessons, patterns
  show_deferred 0
  show_estimation
  show_lessons 10
  show_patterns
elif [ "$PHASE" = "review" ]; then
  # REVIEW: Patterns, antibodies, deferred, recent lessons
  show_patterns
  show_antibodies
  show_crystallized
  show_deferred 5
  show_lessons 3
elif [ "$PHASE" = "implementation" ]; then
  # IMPLEMENTATION: Patterns, antibodies, crystallized, trimmed lessons + deferred
  show_patterns
  show_antibodies
  show_crystallized
  show_lessons 3
  show_deferred 3
fi

# ═══════════════════════════════════════════════════════════════════════════════
# BOTTOM — Second highest attention zone (recency effect)
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Workflow checklist ───────────────────────────────────────────────────────

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

# ─── Self-correction protocol ────────────────────────────────────────────────

echo "SELF-CORRECTION: After every commit, verify with 'npm run typecheck' before proceeding to next task. Never stack commits without typechecking."
echo ""

# ─── Session recovery (optional JSONL scanning) ─────────────────────────────

RECOVER_SCRIPT="/home/hb/radl-ops/src/scripts/session-recover.ts"
if [ -f "$RECOVER_SCRIPT" ] && command -v npx &>/dev/null; then
  RECOVERY=$(npx --yes tsx "$RECOVER_SCRIPT" --hours 12 2>/dev/null | head -20)
  if [ -n "$RECOVERY" ] && [ "$RECOVERY" != "No recent sessions found." ]; then
    echo "$RECOVERY"
    echo ""
  fi
fi

# ─── Iron laws reinforcement (bottom placement for recency effect) ────────────

echo "IRON LAWS: No push to main | No delete prod data | No commit secrets | 3-strike stop | No modify CI/CD | No force push"
echo ""
echo "=== END FULL CONTEXT RESTORE ==="

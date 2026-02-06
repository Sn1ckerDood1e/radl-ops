#!/bin/bash
# Session Initialization Script
# Based on planning-with-files pattern: loads context, creates session files,
# and prepares structured note-taking for the session.
#
# Usage: ./init-session.sh [mode]
#   mode: "build" (default) or "maintain"
#
# Creates:
#   - Session log file in logs/
#   - Loads knowledge base context
#   - Shows model routing configuration
#   - Loads sprint state

set -e

RADL_OPS_DIR="/home/hb/radl-ops"
RADL_DIR="/home/hb/radl"
LOGS_DIR="$RADL_OPS_DIR/logs"
SPRINT_DIR="$RADL_DIR/.planning/sprints"
KNOWLEDGE_DIR="$RADL_OPS_DIR/knowledge"
SESSION_MODE="${1:-build}"
SESSION_DATE=$(date '+%Y-%m-%d')
SESSION_TIME=$(date '+%H:%M:%S')
SESSION_FILE="$LOGS_DIR/session-$SESSION_DATE.md"

mkdir -p "$LOGS_DIR"

# ============================================
# Session Header
# ============================================
echo "╔══════════════════════════════════════════════════════╗"
echo "║            RADL OPS - Session Init v0.3             ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Date: $SESSION_DATE  Time: $SESSION_TIME              ║"
echo "║  Mode: $SESSION_MODE                                       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ============================================
# 1. Service Health (quick check)
# ============================================
echo "## Quick Health Check"
echo ""

# GitHub rate limit
if [ -n "$GITHUB_TOKEN" ] || [ -n "$GH_TOKEN" ]; then
  RATE=$(curl -s -H "Authorization: token ${GITHUB_TOKEN:-$GH_TOKEN}" https://api.github.com/rate_limit 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"  GitHub: {d['rate']['remaining']}/{d['rate']['limit']} remaining\")" 2>/dev/null || echo "  GitHub: Unable to check")
  echo "$RATE"
else
  echo "  GitHub: No token configured"
fi

echo ""

# ============================================
# 2. Sprint State
# ============================================
echo "## Sprint State"
CURRENT_SPRINT="$SPRINT_DIR/current.json"
if [ -f "$CURRENT_SPRINT" ]; then
  python3 << 'PYEOF'
import json

try:
    with open('/home/hb/radl/.planning/sprints/current.json', 'r') as f:
        data = json.load(f)
    print(f"  Phase: {data.get('phase', 'Unknown')}")
    print(f"  Title: {data.get('title', 'Unknown')}")
    print(f"  Status: {data.get('status', 'Unknown')}")
    completed = data.get('completedTasks', [])
    print(f"  Completed tasks: {len(completed)}")
    blockers = [b for b in data.get('blockers', []) if not b.get('resolved', False)]
    if blockers:
        print(f"  BLOCKERS: {len(blockers)}")
        for b in blockers:
            print(f"    - {b.get('description', 'Unknown')}")
except Exception as e:
    print(f"  Error reading sprint: {e}")
PYEOF
else
  echo "  No active sprint."
fi
echo ""

# ============================================
# 3. Recent Git Activity
# ============================================
echo "## Recent Activity (last 5 commits)"
cd "$RADL_DIR" 2>/dev/null && git log --oneline -5 2>/dev/null || echo "  Unable to read git log"
echo ""

# ============================================
# 4. Knowledge Base Summary
# ============================================
echo "## Knowledge Base (Apply These!)"
python3 << 'PYEOF'
import json
from pathlib import Path

kb_dir = Path('/home/hb/radl-ops/knowledge')

# Patterns - show ALL, these should be applied
patterns_file = kb_dir / 'patterns.json'
if patterns_file.exists():
    patterns = json.load(open(patterns_file))['patterns']
    if patterns:
        print(f"  PATTERNS ({len(patterns)}) — apply these in code:")
        for p in patterns:
            print(f"    * {p.get('name', '?')}: {p.get('description', '')}")
            if p.get('example'):
                print(f"      Example: {p.get('example', '')[:80]}")
    else:
        print("  No patterns yet")
else:
    print("  No patterns yet")

print()

# Lessons - show ALL, these prevent repeat mistakes
lessons_file = kb_dir / 'lessons.json'
if lessons_file.exists():
    lessons = json.load(open(lessons_file))['lessons']
    if lessons:
        print(f"  LESSONS ({len(lessons)}) — avoid these mistakes:")
        for l in lessons:
            print(f"    * {l.get('learning', '?')}")
    else:
        print("  No lessons yet")
else:
    print("  No lessons yet")

print()

# Decisions - show recent 5
decisions_file = kb_dir / 'decisions.json'
if decisions_file.exists():
    decisions = json.load(open(decisions_file))['decisions']
    if decisions:
        print(f"  DECISIONS ({len(decisions)} total, showing last 5):")
        for d in decisions[-5:]:
            print(f"    * [{d.get('phase', '?')}] {d.get('title', '?')}")
            if d.get('rationale'):
                print(f"      Why: {d.get('rationale', '')[:80]}")
    else:
        print("  No decisions yet")
else:
    print("  No decisions yet")
PYEOF
echo ""

# ============================================
# 5. Model Routing (v0.3)
# ============================================
echo "## Model Routing"
echo "  briefing:      haiku/low     (fast, cheap summaries)"
echo "  tool_execution: sonnet/medium (tool call handling)"
echo "  conversation:  sonnet/medium (general chat)"
echo "  planning:      sonnet/high   (feature planning)"
echo "  review:        sonnet/high   (code/content review)"
echo "  architecture:  opus/high     (system design)"
echo "  roadmap:       opus/high     (strategic thinking)"
echo ""

# ============================================
# 6. API Cost Summary
# ============================================
echo "## API Costs"
TODAY_USAGE="$RADL_OPS_DIR/usage-logs/usage-$SESSION_DATE.jsonl"
if [ -f "$TODAY_USAGE" ]; then
  python3 << PYEOF
import json

total_cost = 0
total_calls = 0

try:
    with open('$TODAY_USAGE', 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            total_cost += entry.get('costUsd', 0)
            total_calls += 1
    print(f"  Today: {total_calls} API calls, \${total_cost:.4f}")
except Exception as e:
    print(f"  Error reading usage: {e}")
PYEOF
else
  echo "  No usage data yet today."
fi
echo ""

# ============================================
# 7. Session File (structured notes)
# ============================================
if [ ! -f "$SESSION_FILE" ]; then
  cat > "$SESSION_FILE" << EOF
# Session: $SESSION_DATE

## Context
- Mode: $SESSION_MODE
- Started: $SESSION_TIME

## Goals
- [ ] (set goals at session start)

## Progress
<!-- Log progress here during session -->

## Decisions Made
<!-- Log decisions here for knowledge.sh -->

## Lessons Learned
<!-- Log lessons here for knowledge.sh -->

## Notes
<!-- Free-form notes -->
EOF
  echo "Session file created: $SESSION_FILE"
else
  echo "Session file exists: $SESSION_FILE"
fi
echo ""

# ============================================
# 8. Mode-specific guidance
# ============================================
if [ "$SESSION_MODE" = "build" ]; then
  echo "## BUILD Mode Guidance"
  echo "  1. Review briefing priorities"
  echo "  2. Plan sprint (3-4 hours realistic)"
  echo "  3. Start: sprint.sh start \"Phase X\" \"Title\" \"estimate\""
  echo "  4. Execute with progress updates"
  echo "  5. Complete: sprint.sh complete \"hash\" \"time\""
elif [ "$SESSION_MODE" = "maintain" ]; then
  echo "## MAINTAIN Mode Guidance"
  echo "  1. Check service health"
  echo "  2. Triage open issues"
  echo "  3. Fix priority issues"
  echo "  4. Verify fixes"
  echo "  5. Release if needed"
fi
echo ""

# ============================================
# 9. Branch Check (CRITICAL)
# ============================================
echo "## Branch Status"
cd "$RADL_DIR" 2>/dev/null
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "  Current branch: $CURRENT_BRANCH"
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "  *** WARNING: On main branch! Create a feature branch before making changes ***"
  echo "  Run: git checkout -b feat/<phase-slug>"
else
  echo "  OK - On feature branch"
fi
echo ""

echo "=== Session initialized. Ready to work. ==="

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

# --- Branch and Recent Git Activity ---
echo "## Branch & Recent Git Activity (radl)"
cd "$RADL_DIR" 2>/dev/null
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "  Current branch: $CURRENT_BRANCH"
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "  WARNING: On main! Create feature branch before making changes."
fi
echo ""
echo "Recent commits:"
git log --oneline -5 2>/dev/null || echo "Unable to read git log"
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

# --- Knowledge Base ---
echo "## Key Decisions"
if [ -f "/home/hb/radl-ops/knowledge/decisions.json" ]; then
  python3 << 'EOF'
import json
from pathlib import Path

decisions_file = Path('/home/hb/radl-ops/knowledge/decisions.json')
if decisions_file.exists():
    with open(decisions_file, 'r') as f:
        decisions = json.load(f)['decisions']
    if decisions:
        for d in decisions[-5:]:  # Last 5 decisions
            print(f"  - [{d.get('phase', '?')}] {d['title']}")
            print(f"    Rationale: {d['rationale'][:60]}...")
    else:
        print("  No decisions logged yet")
EOF
else
  echo "  No decisions logged yet"
fi
echo ""

echo "## Lessons Learned"
if [ -f "/home/hb/radl-ops/knowledge/lessons.json" ]; then
  python3 << 'EOF'
import json
from pathlib import Path

lessons_file = Path('/home/hb/radl-ops/knowledge/lessons.json')
if lessons_file.exists():
    with open(lessons_file, 'r') as f:
        lessons = json.load(f)['lessons']
    if lessons:
        for l in lessons[-5:]:  # Last 5 lessons
            print(f"  - {l['learning']}")
    else:
        print("  No lessons logged yet")
EOF
else
  echo "  No lessons logged yet"
fi
echo ""

echo "## Established Patterns"
if [ -f "/home/hb/radl-ops/knowledge/patterns.json" ]; then
  python3 << 'EOF'
import json
from pathlib import Path

patterns_file = Path('/home/hb/radl-ops/knowledge/patterns.json')
if patterns_file.exists():
    with open(patterns_file, 'r') as f:
        patterns = json.load(f)['patterns']
    if patterns:
        for p in patterns:
            print(f"  - **{p['name']}**: {p['description'][:50]}...")
    else:
        print("  No patterns logged yet")
EOF
else
  echo "  No patterns logged yet"
fi
echo ""

# --- Sprint Velocity ---
echo "## Sprint Velocity (calibration)"
python3 << 'EOF'
import json
from pathlib import Path

sprint_dir = Path('/home/hb/radl/.planning/sprints')
completed = sorted(sprint_dir.glob('completed-*.json'), reverse=True)[:10]

if not completed:
    print("  No completed sprints for velocity calculation")
else:
    ratios = []
    for f in completed:
        try:
            with open(f, 'r') as file:
                data = json.load(file)
            est = data.get('estimate', '')
            act = data.get('actualTime', '')
            if est and act:
                est_hrs = float(est.split()[0])
                act_hrs = float(act.split()[0])
                if est_hrs > 0:
                    ratios.append(act_hrs / est_hrs)
        except:
            pass

    if ratios:
        avg_ratio = sum(ratios) / len(ratios)
        print(f"  Velocity factor: {avg_ratio:.2f}x")
        print(f"  (Multiply estimates by {avg_ratio:.2f} for realistic time)")
        print(f"  Example: 3hr estimate → expect ~{3 * avg_ratio:.1f}hr actual")
    else:
        print("  Insufficient data for velocity calculation")
EOF
echo ""

# --- Instructions for Claude ---
echo "## Instructions"
echo "1. Review the current sprint status above"
echo "2. Check the latest checkpoint if context was lost mid-task"
echo "3. Review key decisions and patterns before making architectural choices"
echo "4. Use 'sprint.sh status' for live status"
echo "5. Use 'sprint.sh progress \"message\"' to continue logging work"
echo "6. If blocked, use 'sprint.sh blocker \"description\"'"
echo "7. Log important decisions: knowledge.sh decision \"title\" \"context\" \"alternatives\" \"rationale\""
echo "8. Log lessons learned: knowledge.sh lesson \"situation\" \"learning\""
echo ""
echo "=== END CONTEXT RESTORATION ==="

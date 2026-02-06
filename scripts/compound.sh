#!/bin/bash
# Compound Engineering Script
# Based on Every.to's compound engineering methodology:
# Plan → Work → Review → Compound → Repeat
#
# The "compound" step extracts lessons from completed sprints
# and stores them in the knowledge base for future sessions.
#
# Usage:
#   compound.sh extract     # Extract lessons from latest sprint
#   compound.sh summarize   # Summarize all recent lessons
#   compound.sh review      # Review what was learned this week

set -e

RADL_OPS_DIR="/home/hb/radl-ops"
RADL_DIR="/home/hb/radl"
KNOWLEDGE_DIR="$RADL_OPS_DIR/knowledge"
SPRINT_DIR="$RADL_DIR/.planning/sprints"
COMPOUND_DIR="$KNOWLEDGE_DIR/compounds"
KNOWLEDGE_SCRIPT="$RADL_OPS_DIR/scripts/knowledge.sh"

mkdir -p "$COMPOUND_DIR"

ACTION="${1:-extract}"

case "$ACTION" in

  extract)
    echo "=== Compound Engineering: Extract ==="
    echo ""

    # Find the latest completed sprint
    LATEST_ARCHIVE=""
    if [ -d "$SPRINT_DIR/archive" ]; then
      LATEST_ARCHIVE=$(ls -t "$SPRINT_DIR/archive"/*.json 2>/dev/null | head -1)
    fi

    if [ -z "$LATEST_ARCHIVE" ]; then
      # Try current sprint
      if [ -f "$SPRINT_DIR/current.json" ]; then
        LATEST_ARCHIVE="$SPRINT_DIR/current.json"
        echo "Using current sprint (not yet archived)."
      else
        echo "No sprint data found."
        exit 0
      fi
    fi

    echo "Analyzing: $(basename "$LATEST_ARCHIVE")"
    echo ""

    # Extract sprint data
    python3 << PYEOF
import json
import os
from datetime import datetime

try:
    with open('$LATEST_ARCHIVE', 'r') as f:
        sprint = json.load(f)
except Exception as e:
    print(f"Error reading sprint: {e}")
    exit(1)

phase = sprint.get('phase', 'Unknown')
title = sprint.get('title', 'Unknown')
status = sprint.get('status', 'Unknown')
completed_tasks = sprint.get('completedTasks', [])
blockers = [b for b in sprint.get('blockers', []) if not b.get('resolved', False)]
resolved_blockers = [b for b in sprint.get('blockers', []) if b.get('resolved', False)]
estimate = sprint.get('estimate', 'Unknown')
actual = sprint.get('actualTime', 'Unknown')

print(f"Phase: {phase}")
print(f"Title: {title}")
print(f"Status: {status}")
print(f"Tasks completed: {len(completed_tasks)}")
print(f"Estimate: {estimate}")
print(f"Actual: {actual}")
print()

# Generate compound insights
insights = []

# 1. Estimation accuracy
if estimate != 'Unknown' and actual != 'Unknown':
    insights.append({
        'type': 'lesson',
        'category': 'estimation',
        'content': f"Sprint '{title}' estimated {estimate}, took {actual}.",
    })

# 2. Blocker patterns
if resolved_blockers:
    for b in resolved_blockers:
        insights.append({
            'type': 'lesson',
            'category': 'blocker',
            'content': f"Blocker resolved: {b.get('description', '?')} - Resolution: {b.get('resolution', 'unknown')}",
        })

# 3. Unresolved blockers
if blockers:
    for b in blockers:
        insights.append({
            'type': 'lesson',
            'category': 'blocker',
            'content': f"UNRESOLVED blocker from {title}: {b.get('description', '?')}",
        })

# 4. Task completion patterns
if completed_tasks:
    print("Completed tasks:")
    for t in completed_tasks:
        if isinstance(t, str):
            print(f"  - {t}")
        elif isinstance(t, dict):
            print(f"  - {t.get('description', t.get('task', '?'))}")

print()

# Save compound file
compound_file = os.path.join('$COMPOUND_DIR', f"compound-{datetime.now().strftime('%Y-%m-%d-%H%M')}.json")
compound_data = {
    'extractedAt': datetime.now().isoformat(),
    'sprintPhase': phase,
    'sprintTitle': title,
    'insights': insights,
    'tasksCompleted': len(completed_tasks),
    'estimate': estimate,
    'actual': actual,
}

with open(compound_file, 'w') as f:
    json.dump(compound_data, f, indent=2)

print(f"Compound data saved: {compound_file}")
print(f"Insights extracted: {len(insights)}")

for i, insight in enumerate(insights, 1):
    print(f"  {i}. [{insight['category']}] {insight['content'][:80]}")

PYEOF
    ;;

  summarize)
    echo "=== Compound Engineering: Summarize ==="
    echo ""

    python3 << 'PYEOF'
import json
import os
from pathlib import Path

compound_dir = Path('/home/hb/radl-ops/knowledge/compounds')
if not compound_dir.exists():
    print("No compound data found.")
    exit(0)

files = sorted(compound_dir.glob('compound-*.json'))
if not files:
    print("No compound files found.")
    exit(0)

all_insights = []
total_sprints = 0
estimation_data = []

for f in files:
    try:
        data = json.load(open(f))
        total_sprints += 1
        all_insights.extend(data.get('insights', []))

        est = data.get('estimate', '')
        act = data.get('actual', '')
        if est and act and est != 'Unknown' and act != 'Unknown':
            estimation_data.append({'estimate': est, 'actual': act, 'title': data.get('sprintTitle', '?')})
    except Exception:
        continue

print(f"Total sprints analyzed: {total_sprints}")
print(f"Total insights: {len(all_insights)}")
print()

# Categorize
by_category = {}
for insight in all_insights:
    cat = insight.get('category', 'other')
    if cat not in by_category:
        by_category[cat] = []
    by_category[cat].append(insight)

for cat, items in by_category.items():
    print(f"## {cat.title()} ({len(items)} insights)")
    for item in items[-5:]:  # Last 5 per category
        print(f"  - {item['content'][:80]}")
    print()

if estimation_data:
    print("## Estimation Accuracy")
    for ed in estimation_data[-5:]:
        print(f"  - {ed['title']}: estimated {ed['estimate']}, actual {ed['actual']}")

PYEOF
    ;;

  review)
    echo "=== Compound Engineering: Weekly Review ==="
    echo ""

    # Show this week's compounds
    python3 << 'PYEOF'
import json
from pathlib import Path
from datetime import datetime, timedelta

compound_dir = Path('/home/hb/radl-ops/knowledge/compounds')
if not compound_dir.exists():
    print("No compound data found.")
    exit(0)

week_ago = datetime.now() - timedelta(days=7)
files = sorted(compound_dir.glob('compound-*.json'))

this_week = []
for f in files:
    try:
        data = json.load(open(f))
        extracted = datetime.fromisoformat(data['extractedAt'])
        if extracted >= week_ago:
            this_week.append(data)
    except Exception:
        continue

if not this_week:
    print("No compounds from this week.")
    exit(0)

print(f"This week: {len(this_week)} sprints compounded")
print()

total_insights = 0
for compound in this_week:
    insights = compound.get('insights', [])
    total_insights += len(insights)
    phase = compound.get('sprintPhase', '?')
    title = compound.get('sprintTitle', '?')
    print(f"### {phase}: {title}")
    print(f"    Tasks: {compound.get('tasksCompleted', 0)}")
    print(f"    Estimate: {compound.get('estimate', '?')} → Actual: {compound.get('actual', '?')}")
    for insight in insights:
        print(f"    - [{insight['category']}] {insight['content'][:60]}")
    print()

print(f"Total insights this week: {total_insights}")

PYEOF
    ;;

  *)
    echo "Usage: compound.sh <extract|summarize|review>"
    echo ""
    echo "Commands:"
    echo "  extract    - Extract lessons from latest completed sprint"
    echo "  summarize  - Summarize all compound insights"
    echo "  review     - Review this week's compounds"
    exit 1
    ;;
esac

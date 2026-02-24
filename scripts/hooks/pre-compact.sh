#!/bin/bash
# Claude Code PreCompact hook
# Auto-checkpoints sprint state before context compaction.
# Ensures sprint progress is not lost during compaction.

SPRINT_SCRIPT="/home/hb/radl-ops/scripts/sprint.sh"
SPRINT_DIR="/home/hb/radl/.planning/sprints"

# Only run in radl contexts
case "$PWD" in
  /home/hb|/home/hb/radl|/home/hb/radl/*|/home/hb/radl-ops|/home/hb/radl-ops/*)
    ;;
  *)
    exit 0
    ;;
esac

# Only checkpoint if there's an active sprint
if [ -f "$SPRINT_DIR/current.json" ]; then
  STATUS=$(python3 -c "import json; print(json.load(open('$SPRINT_DIR/current.json')).get('status',''))" 2>/dev/null)
  if [ "$STATUS" = "active" ] || [ "$STATUS" = "in_progress" ]; then
    "$SPRINT_SCRIPT" checkpoint 2>/dev/null
    echo "Sprint state checkpointed before compaction"
  fi
fi

# Emit structured snapshot for context restoration after compaction
echo ""
echo "=== PRE-COMPACT SNAPSHOT ==="

# Branch info
BRANCH=$(git -C /home/hb/radl rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "BRANCH: $BRANCH"

# Last 5 commits on this branch
echo "RECENT COMMITS:"
git -C /home/hb/radl log --oneline -5 2>/dev/null | while read -r line; do
  echo "  $line"
done

# Files changed vs main
CHANGED=$(git -C /home/hb/radl diff --name-only main...HEAD 2>/dev/null | wc -l)
echo "FILES CHANGED VS MAIN: $CHANGED"

# Unresolved review findings count
FINDINGS_FILE="/home/hb/radl-ops/knowledge/review-findings.json"
if [ -f "$FINDINGS_FILE" ]; then
  UNRESOLVED=$(python3 -c "
import json
data = json.load(open('$FINDINGS_FILE'))
findings = data if isinstance(data, list) else data.get('findings', [])
print(sum(1 for f in findings if not f.get('resolved', False)))
" 2>/dev/null || echo "0")
  echo "UNRESOLVED REVIEW FINDINGS: $UNRESOLVED"
fi

echo "=== END SNAPSHOT ==="

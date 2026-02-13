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

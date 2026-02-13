#!/bin/bash
# Claude Code PreToolUse hook — sprint guard
# Warns if committing without an active sprint.
# Reads TOOL_INPUT from stdin (JSON with command field).
# Advisory only — never blocks (always exits 0).

SPRINT_DIR="/home/hb/radl/.planning/sprints"

# Only runs for Bash tool
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Read tool input from stdin
INPUT=$(cat)

# Extract command from JSON
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command',''))" 2>/dev/null || echo "")

# Only trigger on git commit commands
if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Check if current.json exists and has an active sprint
if [ ! -f "$SPRINT_DIR/current.json" ]; then
  echo "WARNING: No active sprint. Start one with sprint_start MCP tool before committing."
  echo "  Commits outside a sprint won't be tracked in sprint history."
  exit 0
fi

STATUS=$(python3 -c "import json; print(json.load(open('$SPRINT_DIR/current.json')).get('status',''))" 2>/dev/null || echo "")

if [ "$STATUS" != "active" ] && [ "$STATUS" != "in_progress" ]; then
  echo "WARNING: Sprint exists but status is '$STATUS' (not active)."
  echo "  Start a new sprint or resume the current one before committing."
fi

# Advisory only — never blocks
exit 0

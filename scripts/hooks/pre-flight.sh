#!/bin/bash
# Claude Code PreToolUse hook — pre-push flight check
# Runs a checklist before git push.
# Reads TOOL_INPUT from stdin (JSON with command field).
# Exits 0 for pass, exits 2 to block if pushing to main/master.

# Only runs for Bash tool
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Read tool input from stdin
INPUT=$(cat)

# Extract command from JSON
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command',''))" 2>/dev/null || echo "")

# Trigger on git push or gh pr create commands
IS_PUSH=false
IS_PR=false
if echo "$COMMAND" | grep -qE 'git\s+push'; then
  IS_PUSH=true
elif echo "$COMMAND" | grep -qE 'gh\s+(pr|pull-request)\s+create'; then
  IS_PR=true
fi

if [ "$IS_PUSH" = false ] && [ "$IS_PR" = false ]; then
  exit 0
fi

RADL_DIR="/home/hb/radl"
SPRINT_DIR="$RADL_DIR/.planning/sprints"

if [ "$IS_PR" = true ]; then
  echo "PR CREATION FLIGHT CHECK:"
else
  echo "PRE-PUSH FLIGHT CHECK:"
fi

PASS=true

# 1. Branch is not main/master
BRANCH=$(cd "$RADL_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "  [FAIL] Branch is $BRANCH — pushing to main/master is blocked"
  echo "         Iron Law #1: Never push directly to main/master."
  echo "         Push to a feature branch and create a PR instead."
  PASS=false
else
  echo "  [PASS] Branch: $BRANCH (not main/master)"
fi

# 2. Sprint is tracked
if [ -f "$SPRINT_DIR/current.json" ]; then
  STATUS=$(python3 -c "import json; print(json.load(open('$SPRINT_DIR/current.json')).get('status',''))" 2>/dev/null || echo "")
  if [ "$STATUS" = "active" ] || [ "$STATUS" = "in_progress" ]; then
    echo "  [PASS] Sprint tracked (status: $STATUS)"
  else
    echo "  [WARN] Sprint exists but status is '$STATUS'"
  fi
else
  echo "  [WARN] No sprint tracked (current.json not found)"
fi

# 3. No uncommitted changes
DIRTY=$(cd "$RADL_DIR" && git status --porcelain 2>/dev/null)
if [ -n "$DIRTY" ]; then
  DIRTY_COUNT=$(echo "$DIRTY" | wc -l | tr -d ' ')
  echo "  [WARN] $DIRTY_COUNT uncommitted changes detected"
else
  echo "  [PASS] Working tree clean"
fi

# Block if pushing to main/master
if [ "$PASS" = false ]; then
  echo ""
  echo "BLOCKED: Push to $BRANCH not allowed."
  exit 2
fi

echo ""
if [ "$IS_PR" = true ]; then
  echo "All checks passed. TIP: Run pre_flight_check MCP tool for full verification (includes typecheck)."
else
  echo "All checks passed. Proceeding with push."
fi
exit 0

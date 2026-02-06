#!/bin/bash
# Claude Code PreToolUse hook: warn if pushing to main
# Reads TOOL_INPUT from stdin (JSON with tool parameters)

# Only runs for Bash tool
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Read tool input from stdin
INPUT=$(cat)

# Check if the command contains git push to main/master
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command',''))" 2>/dev/null || echo "")

if echo "$COMMAND" | grep -qE 'git\s+push.*\b(main|master)\b'; then
  # Check if it's pushing to a remote branch named main/master
  echo "BLOCKED: Pushing to main/master branch detected."
  echo ""
  echo "Iron Law #1: Never push directly to main/master."
  echo "Push to your feature branch instead, then create a PR."
  echo ""
  echo "If the user explicitly requested this, they can approve."
  exit 2
fi

exit 0

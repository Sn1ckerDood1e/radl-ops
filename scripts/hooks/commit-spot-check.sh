#!/bin/bash
# Claude Code PostToolUse hook — commit spot-check reminder
# After a git commit, suggests running spot_check_diff to catch common issues.
# Advisory only — never blocks (always exits 0).

# Only runs for Bash tool
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Read tool input from stdin
INPUT=$(cat)

# Extract command from JSON
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command',''))" 2>/dev/null || echo "")

# Only trigger on git commit commands (not amend — those are already reviewed)
if ! echo "$COMMAND" | grep -qE 'git\s+commit' || echo "$COMMAND" | grep -q '\-\-amend'; then
  exit 0
fi

echo "TIP: Run spot_check_diff MCP tool to catch common issues (any types, console.log, missing CSRF, secrets). Cost: ~\$0.002."

# Advisory only — never blocks
exit 0

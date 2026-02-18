#!/usr/bin/env bash
# Post-commit verify_patterns reminder
# Only outputs if the Bash command was an actual git commit.
# Runs as a PostToolUse command hook (silent unless relevant).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Exit silently if not a git commit
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

echo "Run verify_patterns MCP tool to check for pattern drift (free, no AI cost)."
echo "Run session_health(record_commit: true) to track commit in session metrics."

#!/bin/bash
# Claude Code PostToolUse hook: remind about typecheck after TS/TSX edits
# Checks if the edited file is TypeScript and suggests running typecheck

# Only runs for Edit and Write tools
if [ "$TOOL_NAME" != "Edit" ] && [ "$TOOL_NAME" != "Write" ]; then
  exit 0
fi

# Read tool input from stdin
INPUT=$(cat)

# Extract file path
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null || echo "")

# Check if it's a TypeScript file in the radl project
if echo "$FILE_PATH" | grep -qE '\.tsx?$'; then
  if echo "$FILE_PATH" | grep -q '/home/hb/radl/'; then
    echo "TypeScript file modified. Run \`npm run typecheck\` to verify."
  fi
fi

# Check if Prisma schema was modified
if echo "$FILE_PATH" | grep -q 'prisma/schema.prisma'; then
  echo "Prisma schema modified. Run verify_data_flow MCP tool for new fields:"
  echo "  verify_data_flow({ field: 'fieldName', model: 'ModelName' })"
  echo "  Zero cost (\$0) — prevents silent data loss (Phase 69 class of bug)."
fi

exit 0

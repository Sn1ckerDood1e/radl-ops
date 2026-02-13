#!/bin/bash
# Claude Code PreToolUse hook — commit risk classifier
# Advisory hook: classifies commit risk by the files being committed.
# Reads TOOL_INPUT from stdin (JSON with command field).
# Never blocks — always exits 0.

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

# Get staged files from the radl project
STAGED=$(cd /home/hb/radl && git diff --cached --name-only 2>/dev/null)

if [ -z "$STAGED" ]; then
  exit 0
fi

HIGH_COUNT=0
MEDIUM_COUNT=0
LOW_COUNT=0
HIGH_FILES=""
MEDIUM_FILES=""

while IFS= read -r file; do
  case "$file" in
    prisma/migrations/*|supabase/migrations/*)
      HIGH_COUNT=$((HIGH_COUNT + 1))
      HIGH_FILES="$HIGH_FILES\n    - $file (migration)"
      ;;
    src/lib/auth/*|src/middleware.ts|src/lib/supabase/*)
      HIGH_COUNT=$((HIGH_COUNT + 1))
      HIGH_FILES="$HIGH_FILES\n    - $file (auth)"
      ;;
    src/app/api/*)
      HIGH_COUNT=$((HIGH_COUNT + 1))
      HIGH_FILES="$HIGH_FILES\n    - $file (API route)"
      ;;
    src/components/*|src/lib/utils/*|src/lib/validations/*)
      MEDIUM_COUNT=$((MEDIUM_COUNT + 1))
      MEDIUM_FILES="$MEDIUM_FILES\n    - $file"
      ;;
    *.test.*|*.spec.*|__tests__/*)
      LOW_COUNT=$((LOW_COUNT + 1))
      ;;
    *.md|*.json|*.config.*|*.mjs)
      LOW_COUNT=$((LOW_COUNT + 1))
      ;;
    *)
      MEDIUM_COUNT=$((MEDIUM_COUNT + 1))
      MEDIUM_FILES="$MEDIUM_FILES\n    - $file"
      ;;
  esac
done <<< "$STAGED"

# Determine overall risk level
if [ "$HIGH_COUNT" -gt 0 ]; then
  OVERALL="HIGH"
elif [ "$MEDIUM_COUNT" -gt 0 ]; then
  OVERALL="MEDIUM"
else
  OVERALL="LOW"
fi

TOTAL=$((HIGH_COUNT + MEDIUM_COUNT + LOW_COUNT))

echo "COMMIT RISK: $OVERALL ($TOTAL files staged)"
if [ "$HIGH_COUNT" -gt 0 ]; then
  echo "  HIGH risk ($HIGH_COUNT files): migrations, auth, API routes"
  echo -e "$HIGH_FILES"
fi
if [ "$MEDIUM_COUNT" -gt 0 ]; then
  echo "  MEDIUM risk ($MEDIUM_COUNT files): components, libs, utils"
fi
if [ "$LOW_COUNT" -gt 0 ]; then
  echo "  LOW risk ($LOW_COUNT files): tests, docs, config"
fi

if [ "$OVERALL" = "HIGH" ]; then
  echo ""
  echo "  Recommendation: Run security-reviewer + code-reviewer before pushing."
fi

# Advisory only — never blocks
exit 0

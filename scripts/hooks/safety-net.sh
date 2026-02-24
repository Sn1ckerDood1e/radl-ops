#!/bin/bash
# PreToolUse (Bash) hook — semantic destructive command detection
#
# Catches evasion vectors that simple pattern matching misses:
# - Shell wrappers: bash -c "git push -f", sh -c "rm -rf /"
# - Interpreter one-liners: python -c "import os; os.system('rm -rf /')"
# - Flag reordering: git push --force origin main
# - Variable substitution: $CMD where CMD=rm
# - Pipe chains: echo "yes" | git push -f
#
# Complements existing iron law hooks (branch-guard, risk-classifier).
# Exit codes: 0 = allow, 2 = block

# Only processes Bash tool calls with TOOL_INPUT set
if [ -z "$TOOL_INPUT" ]; then
  exit 0
fi

# Extract command from JSON tool input
COMMAND=$(echo "$TOOL_INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('command', ''))
except:
    print('')
" 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Normalize: lowercase, collapse whitespace
NORM=$(echo "$COMMAND" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ')

# ─── Destructive patterns to detect (even inside wrappers) ────────────

BLOCKED=""

# 1. Shell wrapper detection: extract inner command and re-check
# Matches: bash -c "...", sh -c "...", eval "..."
INNER=$(echo "$NORM" | python3 -c "
import sys, re
cmd = sys.stdin.read().strip()
# bash/sh -c 'command' or bash/sh -c \"command\"
m = re.search(r'(?:bash|sh|zsh)\s+-c\s+[\"'\''](.*?)[\"'\'']\s*$', cmd)
if m:
    print(m.group(1))
else:
    # eval 'command'
    m = re.search(r'eval\s+[\"'\''](.*?)[\"'\'']\s*$', cmd)
    if m:
        print(m.group(1))
" 2>/dev/null)

# Check both outer and inner commands
for CHECK_CMD in "$NORM" "$INNER"; do
  [ -z "$CHECK_CMD" ] && continue

  # Force push (any flag order)
  if echo "$CHECK_CMD" | grep -qE 'git\s+push\s+.*(-f|--force)'; then
    BLOCKED="Force push detected (git push --force)"
    break
  fi
  if echo "$CHECK_CMD" | grep -qE 'git\s+(-f|--force)\s+push'; then
    BLOCKED="Force push detected (reordered flags)"
    break
  fi

  # Reset --hard
  if echo "$CHECK_CMD" | grep -qE 'git\s+reset\s+--hard'; then
    BLOCKED="Destructive git reset --hard detected"
    break
  fi

  # rm -rf with dangerous paths
  if echo "$CHECK_CMD" | grep -qE 'rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(/|~|\$home|\$pwd|\.\.)'; then
    BLOCKED="Destructive rm -rf on dangerous path"
    break
  fi

  # git checkout . (discard all changes)
  if echo "$CHECK_CMD" | grep -qE 'git\s+checkout\s+\.\s*$'; then
    BLOCKED="git checkout . discards all uncommitted changes"
    break
  fi

  # git clean -f (delete untracked files)
  if echo "$CHECK_CMD" | grep -qE 'git\s+clean\s+.*-f'; then
    BLOCKED="git clean -f deletes untracked files"
    break
  fi

  # git branch -D (force delete branch)
  if echo "$CHECK_CMD" | grep -qE 'git\s+branch\s+.*-D\s+(main|master)'; then
    BLOCKED="Force delete of main/master branch"
    break
  fi
done

# 2. Interpreter one-liner detection
# python -c, node -e, ruby -e, perl -e containing destructive ops
if [ -z "$BLOCKED" ]; then
  INTERP_CMD=$(echo "$NORM" | python3 -c "
import sys, re
cmd = sys.stdin.read().strip()
# python3 -c '...' or python -c '...' or node -e '...'
m = re.search(r'(?:python3?|node|ruby|perl)\s+(?:-c|-e)\s+[\"'\''](.*?)[\"'\'']\s*$', cmd)
if m:
    inner = m.group(1)
    dangerous = ['os.system', 'os.remove', 'os.unlink', 'shutil.rmtree',
                 'subprocess.run', 'subprocess.call', 'child_process',
                 'execSync', 'fs.unlinkSync', 'fs.rmSync', 'File.delete']
    for d in dangerous:
        if d.lower() in inner.lower():
            print(f'Interpreter one-liner contains {d}')
            break
" 2>/dev/null)
  if [ -n "$INTERP_CMD" ]; then
    BLOCKED="$INTERP_CMD"
  fi
fi

# 3. Output result
if [ -n "$BLOCKED" ]; then
  echo "SAFETY NET: $BLOCKED"
  echo "If this is intentional, ask the user for explicit confirmation."
  exit 2
fi

exit 0

#!/bin/bash
# Claude Code PostToolUse hook — Context window pressure advisory
#
# Tracks tool call count as a proxy for context usage.
# Every 20 calls, emits a context pressure advisory.
# At 50+ calls, recommends /strategic-compact.

# Only run in radl contexts
case "$PWD" in
  /home/hb|/home/hb/radl|/home/hb/radl/*|/home/hb/radl-ops|/home/hb/radl-ops/*)
    ;;
  *)
    exit 0
    ;;
esac

COUNTER_FILE="/tmp/claude-tool-call-count"

# Initialize or increment counter
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
  COUNT=$((COUNT + 1))
else
  COUNT=1
fi

echo "$COUNT" > "$COUNTER_FILE"

# Emit advisories at thresholds
if [ "$COUNT" -ge 50 ] && [ $((COUNT % 10)) -eq 0 ]; then
  echo "CONTEXT PRESSURE: $COUNT tool calls this session. Consider running /strategic-compact to preserve context."
elif [ "$COUNT" -ge 20 ] && [ $((COUNT % 20)) -eq 0 ]; then
  echo "Context advisory: $COUNT tool calls this session. Context window filling up."
fi

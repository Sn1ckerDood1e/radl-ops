#!/bin/bash
# GitHub Issue Watcher — Autonomous dispatcher for radl-ops
#
# Polls GitHub for issues with "approved" label, executes them one at a time
# using claude -p, and creates PRs with the results.
#
# Usage:
#   watcher.sh start    — Launch watcher in a tmux session (radl-watcher)
#   watcher.sh stop     — Kill the tmux session
#   watcher.sh status   — Show if running, current issue, queue depth
#   watcher.sh logs     — Tail recent log output
#   watcher.sh run      — Run the poll loop directly (used inside tmux)

set -euo pipefail

# --- Configuration ---
RADL_OPS_DIR="${RADL_OPS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
RADL_DIR="${RADL_DIR:-/home/hb/radl}"

source "$RADL_OPS_DIR/.env" 2>/dev/null || true

POLL_INTERVAL="${WATCHER_POLL_INTERVAL:-60}"
MAX_TURNS="${WATCHER_MAX_TURNS:-75}"
MAX_BUDGET="${WATCHER_MAX_BUDGET:-5.00}"
TIMEOUT="${WATCHER_TIMEOUT:-7200}"
REPO="${WATCHER_REPO:-Sn1ckerDood1e/Radl}"
TMUX_SESSION="radl-watcher"
LOG_DIR="$RADL_OPS_DIR/logs/watcher"
STATE_FILE="$LOG_DIR/.watcher-state"
PROMPT_TEMPLATE="$RADL_OPS_DIR/scripts/watcher-prompt.md"

GH="${GH_BIN:-$(command -v gh 2>/dev/null || echo "$HOME/.local/bin/gh")}"

# Resolve Claude CLI path dynamically (same pattern as daily-briefing.sh)
NODE_VERSION=$(node -v 2>/dev/null || true)
NVM_CLAUDE="$HOME/.nvm/versions/node/${NODE_VERSION}/bin/claude"
if command -v claude &>/dev/null; then
  CLAUDE_BIN="claude"
elif [ -n "$NODE_VERSION" ] && [ -x "$NVM_CLAUDE" ]; then
  CLAUDE_BIN="$NVM_CLAUDE"
else
  CLAUDE_BIN="/home/hb/.nvm/versions/node/v22.22.0/bin/claude"
fi

mkdir -p "$LOG_DIR"

# --- Helpers ---

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-50
}

write_state() {
  echo "$1" > "$STATE_FILE"
}

read_state() {
  cat "$STATE_FILE" 2>/dev/null || echo "unknown"
}

render_prompt() {
  local issue_num="$1"
  local issue_title="$2"
  local issue_body="$3"
  local branch_name="$4"

  sed \
    -e "s|{{ISSUE_NUM}}|$issue_num|g" \
    -e "s|{{ISSUE_TITLE}}|$issue_title|g" \
    -e "s|{{BRANCH_NAME}}|$branch_name|g" \
    "$PROMPT_TEMPLATE" | \
  awk -v body="$issue_body" '{gsub(/\{\{ISSUE_BODY\}\}/, body); print}'
}

gh_api() {
  "$GH" api "$@" 2>/dev/null
}

add_label() {
  local issue_num="$1"
  local label="$2"
  "$GH" issue edit "$issue_num" --repo "$REPO" --add-label "$label" 2>/dev/null || true
}

remove_label() {
  local issue_num="$1"
  local label="$2"
  "$GH" issue edit "$issue_num" --repo "$REPO" --remove-label "$label" 2>/dev/null || true
}

comment_issue() {
  local issue_num="$1"
  local body="$2"
  "$GH" issue comment "$issue_num" --repo "$REPO" --body "$body" 2>/dev/null || true
}

# --- Commands ---

cmd_start() {
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "Watcher already running in tmux session '$TMUX_SESSION'."
    echo "Use 'watcher.sh status' to check or 'watcher.sh stop' to kill it."
    exit 1
  fi

  if [ ! -x "$GH" ]; then
    echo "ERROR: gh CLI not found. Install from https://cli.github.com/"
    exit 1
  fi

  if ! "$GH" auth status &>/dev/null; then
    echo "ERROR: gh CLI not authenticated. Run 'gh auth login' first."
    exit 1
  fi

  if [ ! -x "$CLAUDE_BIN" ] && ! command -v "$CLAUDE_BIN" &>/dev/null; then
    echo "ERROR: Claude CLI not found at $CLAUDE_BIN"
    exit 1
  fi

  echo "Starting watcher in tmux session '$TMUX_SESSION'..."
  tmux new-session -d -s "$TMUX_SESSION" "$RADL_OPS_DIR/scripts/watcher.sh run"
  echo "Watcher started. Use 'watcher.sh logs' to follow output."
}

cmd_stop() {
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    tmux kill-session -t "$TMUX_SESSION"
    write_state "stopped"
    echo "Watcher stopped."
  else
    echo "Watcher is not running."
  fi
}

cmd_status() {
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    local state
    state=$(read_state)
    echo "Watcher: RUNNING (tmux session '$TMUX_SESSION')"
    echo "State:   $state"

    # Show approved issues waiting
    local queue
    queue=$("$GH" issue list --repo "$REPO" --label "approved" --state open --json number,title 2>/dev/null || echo "[]")
    local count
    count=$(echo "$queue" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
    echo "Queue:   $count approved issues waiting"

    # Show in-progress issues
    local active
    active=$("$GH" issue list --repo "$REPO" --label "in-progress" --state open --json number,title 2>/dev/null || echo "[]")
    local active_count
    active_count=$(echo "$active" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
    if [ "$active_count" != "0" ] && [ "$active_count" != "?" ]; then
      echo "Active:  $active_count issue(s) in progress"
    fi
  else
    echo "Watcher: NOT RUNNING"
    echo "Start with: watcher.sh start"
  fi
}

cmd_logs() {
  local latest
  latest=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)
  if [ -n "$latest" ]; then
    echo "=== Latest log: $latest ==="
    tail -f "$latest"
  else
    echo "No log files found in $LOG_DIR/"
  fi
}

cmd_run() {
  # Main poll loop — runs inside tmux
  log "Watcher started. Polling $REPO every ${POLL_INTERVAL}s."
  log "Config: max_turns=$MAX_TURNS, max_budget=\$${MAX_BUDGET}, timeout=${TIMEOUT}s"
  write_state "polling"

  while true; do
    process_queue
    sleep "$POLL_INTERVAL"
  done
}

process_queue() {
  # Fetch open issues with "approved" label, oldest first
  local issues
  issues=$("$GH" issue list \
    --repo "$REPO" \
    --label "approved" \
    --state open \
    --json number,title,body \
    --search "sort:created-asc" \
    --limit 10 2>/dev/null || echo "[]")

  local count
  count=$(echo "$issues" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  if [ "$count" = "0" ]; then
    return
  fi

  log "Found $count approved issue(s). Processing oldest first."

  # Process one issue at a time (serial execution)
  local first_issue
  first_issue=$(echo "$issues" | python3 -c "
import sys, json
issues = json.load(sys.stdin)
if issues:
    i = issues[0]
    # Escape for shell: replace single quotes
    title = i['title'].replace(\"'\", \"'\\\\''\")
    body = (i.get('body') or '(no description)').replace(\"'\", \"'\\\\''\")
    print(f\"{i['number']}\\n{title}\\n{body}\")
" 2>/dev/null || echo "")

  if [ -z "$first_issue" ]; then
    return
  fi

  local issue_num issue_title issue_body
  issue_num=$(echo "$first_issue" | head -1)
  issue_title=$(echo "$first_issue" | sed -n '2p')
  issue_body=$(echo "$first_issue" | tail -n +3)

  process_issue "$issue_num" "$issue_title" "$issue_body"
}

process_issue() {
  local issue_num="$1"
  local issue_title="$2"
  local issue_body="$3"

  local date_stamp
  date_stamp=$(date +%Y-%m-%d)
  local log_file="$LOG_DIR/${date_stamp}-issue-${issue_num}.log"
  local slug
  slug=$(slugify "$issue_title")
  local branch_name="auto/issue-${issue_num}-${slug}"

  log "Processing issue #$issue_num: $issue_title"
  write_state "processing issue #$issue_num: $issue_title"

  # Update labels
  remove_label "$issue_num" "approved"
  add_label "$issue_num" "in-progress"
  comment_issue "$issue_num" "Watcher picked up this issue. Working on branch \`$branch_name\`..."

  # Prepare git
  cd "$RADL_DIR"

  local git_ok=true
  {
    git checkout main &&
    git pull origin main &&
    git checkout -b "$branch_name"
  } >> "$log_file" 2>&1 || git_ok=false

  if [ "$git_ok" = false ]; then
    log "ERROR: Git setup failed for issue #$issue_num"
    fail_issue "$issue_num" "Git setup failed (checkout main / pull / create branch). Check watcher logs." "$log_file" "$branch_name"
    return
  fi

  # Render prompt
  local prompt
  prompt=$(render_prompt "$issue_num" "$issue_title" "$issue_body" "$branch_name")

  # Run claude -p
  # Unset CLAUDECODE to avoid "nested session" error when watcher is started from within Claude Code
  unset CLAUDECODE
  log "Running claude -p for issue #$issue_num (timeout: ${TIMEOUT}s, budget: \$${MAX_BUDGET})..."
  local claude_exit=0
  timeout "$TIMEOUT" "$CLAUDE_BIN" -p "$prompt" \
    --max-turns "$MAX_TURNS" \
    --permission-mode bypassPermissions \
    --max-budget-usd "$MAX_BUDGET" \
    >> "$log_file" 2>&1 || claude_exit=$?

  if [ "$claude_exit" -eq 124 ]; then
    log "TIMEOUT: Issue #$issue_num exceeded ${TIMEOUT}s"
    fail_issue "$issue_num" "Execution timed out after ${TIMEOUT}s. Partial work may exist on branch \`$branch_name\`." "$log_file" "$branch_name"
    return
  fi

  if [ "$claude_exit" -ne 0 ]; then
    log "FAILED: Claude exited with code $claude_exit for issue #$issue_num"
    fail_issue "$issue_num" "Claude exited with code $claude_exit. Check [watcher logs](branch: \`$branch_name\`)." "$log_file" "$branch_name"
    return
  fi

  # Check if any commits were made
  cd "$RADL_DIR"
  local commit_count
  commit_count=$(git log main..HEAD --oneline 2>/dev/null | wc -l || echo "0")

  if [ "$commit_count" -eq 0 ]; then
    log "WARNING: No commits made for issue #$issue_num"
    fail_issue "$issue_num" "Claude completed but made no commits. The issue may need a clearer description." "$log_file" "$branch_name"
    return
  fi

  # Push and create PR
  log "Pushing $commit_count commit(s) for issue #$issue_num..."
  local push_ok=true
  git push -u origin "$branch_name" >> "$log_file" 2>&1 || push_ok=false

  if [ "$push_ok" = false ]; then
    log "ERROR: Git push failed for issue #$issue_num"
    fail_issue "$issue_num" "Git push failed for branch \`$branch_name\`. Check watcher logs." "$log_file" "$branch_name"
    return
  fi

  # Create PR
  local pr_url
  pr_url=$("$GH" pr create \
    --repo "$REPO" \
    --title "$issue_title" \
    --body "$(cat <<EOF
## Summary

Automated implementation for #$issue_num.

**Branch:** \`$branch_name\`
**Commits:** $commit_count

## Source Issue

Closes #$issue_num

---
*Automated by radl-ops issue watcher. Review before merging.*
EOF
)" \
    --label "watcher" \
    --head "$branch_name" \
    --base main 2>/dev/null || echo "")

  if [ -z "$pr_url" ]; then
    log "WARNING: PR creation failed for issue #$issue_num (push succeeded)"
    comment_issue "$issue_num" "Branch pushed but PR creation failed. Create manually from \`$branch_name\`."
    # Still mark completed since work is done
  fi

  # Mark success
  remove_label "$issue_num" "in-progress"
  add_label "$issue_num" "completed"

  if [ -n "$pr_url" ]; then
    comment_issue "$issue_num" "Done! PR created: $pr_url ($commit_count commits)"
    log "SUCCESS: Issue #$issue_num → $pr_url"
  else
    log "PARTIAL: Issue #$issue_num pushed to $branch_name but PR creation failed"
  fi

  # Return to main for next issue
  cd "$RADL_DIR"
  git checkout main >> "$log_file" 2>&1 || true

  write_state "polling"
}

fail_issue() {
  local issue_num="$1"
  local reason="$2"
  local log_file="$3"
  local branch_name="$4"

  remove_label "$issue_num" "in-progress"
  add_label "$issue_num" "failed"
  comment_issue "$issue_num" "Watcher failed: $reason"

  # Clean up: return to main and delete failed branch
  cd "$RADL_DIR"
  git checkout main >> "$log_file" 2>&1 || true
  git branch -D "$branch_name" >> "$log_file" 2>&1 || true

  write_state "polling"
}

# --- Main ---

case "${1:-help}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   cmd_logs ;;
  run)    cmd_run ;;
  help|*)
    echo "Usage: watcher.sh <command>"
    echo ""
    echo "Commands:"
    echo "  start   — Launch watcher in tmux session"
    echo "  stop    — Kill the tmux session"
    echo "  status  — Show running state and queue depth"
    echo "  logs    — Tail the latest log file"
    echo "  run     — Run poll loop directly (used inside tmux)"
    echo ""
    echo "Configuration (via .env or environment):"
    echo "  WATCHER_POLL_INTERVAL  Poll interval in seconds (default: 60)"
    echo "  WATCHER_MAX_TURNS      Max claude -p turns per issue (default: 75)"
    echo "  WATCHER_MAX_BUDGET     Max USD per issue (default: 5.00)"
    echo "  WATCHER_TIMEOUT        Max seconds per issue (default: 7200)"
    echo "  WATCHER_REPO           GitHub owner/repo (default: Sn1ckerDood1e/Radl)"
    ;;
esac

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
MAX_SUBISSUES="${WATCHER_MAX_SUBISSUES:-5}"
REPO="${WATCHER_REPO:-Sn1ckerDood1e/Radl}"
TMUX_SESSION="radl-watcher"
LOG_DIR="$RADL_OPS_DIR/logs/watcher"
STATE_FILE="$LOG_DIR/.watcher-state"
PROMPT_TEMPLATE="$RADL_OPS_DIR/scripts/watcher-prompt.md"
FAILURE_COUNT_FILE="$LOG_DIR/.failure-count"
MAX_CONSECUTIVE_FAILURES="${WATCHER_MAX_FAILURES:-3}"

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

mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"

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

read_failure_count() {
  cat "$FAILURE_COUNT_FILE" 2>/dev/null || echo "0"
}

increment_failure_count() {
  local count
  count=$(read_failure_count)
  count=$((count + 1))
  echo "$count" > "$FAILURE_COUNT_FILE"
  echo "$count"
}

reset_failure_count() {
  echo "0" > "$FAILURE_COUNT_FILE"
}

render_prompt() {
  local issue_num="$1"
  local issue_title="$2"
  local issue_body="$3"
  local branch_name="$4"

  # Sanitize replacement strings for awk gsub:
  # - & expands to matched text in gsub replacement (must escape as \&)
  # - \ must be escaped first to prevent double-escaping
  # - awk -v interprets \n as real newline (must escape as \\n)
  local safe_title safe_body safe_branch
  safe_title=$(printf '%s' "$issue_title" | sed 's/\\/\\\\/g; s/&/\\&/g')
  safe_body=$(printf '%s' "$issue_body" | sed 's/\\/\\\\/g; s/&/\\&/g')
  safe_branch=$(printf '%s' "$branch_name" | sed 's/\\/\\\\/g; s/&/\\&/g')

  awk \
    -v num="$issue_num" \
    -v title="$safe_title" \
    -v body="$safe_body" \
    -v branch="$safe_branch" \
    -v repo="$REPO" \
    '{
      gsub(/\{\{ISSUE_NUM\}\}/, num);
      gsub(/\{\{ISSUE_TITLE\}\}/, title);
      gsub(/\{\{ISSUE_BODY\}\}/, body);
      gsub(/\{\{BRANCH_NAME\}\}/, branch);
      gsub(/\{\{REPO\}\}/, repo);
      print
    }' "$PROMPT_TEMPLATE"
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

  write_state "starting"
  echo "Starting watcher in tmux session '$TMUX_SESSION'..."
  tmux new-session -d -s "$TMUX_SESSION" "$RADL_OPS_DIR/scripts/watcher.sh run"
  echo "Watcher started. Use 'watcher.sh logs' to follow output."
}

cmd_stop() {
  # Kill any lingering antibody processes before killing tmux
  pkill -f "watcher-antibody.mjs" 2>/dev/null || true
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
    queue=$("$GH" issue list --repo "$REPO" --label "approved" --state open --json number,title,labels 2>/dev/null || echo "[]")
    local count
    count=$(echo "$queue" | python3 -c "
import sys, json
SKIP = {'failed', 'decomposed', 'in-progress'}
issues = json.load(sys.stdin)
print(sum(1 for i in issues if not ({l['name'] for l in i.get('labels',[])} & SKIP)))
" 2>/dev/null || echo "?")
    echo "Queue:   $count approved issues waiting"

    # Show in-progress issues
    local active
    active=$("$GH" issue list --repo "$REPO" --label "in-progress" --state open --json number,title 2>/dev/null || echo "[]")
    local active_count
    active_count=$(echo "$active" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
    if [ "$active_count" != "0" ] && [ "$active_count" != "?" ]; then
      echo "Active:  $active_count issue(s) in progress"
    fi

    # Show failure count if any
    local failures
    failures=$(read_failure_count)
    if [ "$failures" -gt 0 ] 2>/dev/null; then
      echo "Failures: $failures consecutive (circuit breaker at $MAX_CONSECUTIVE_FAILURES)"
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
  # Unset CLAUDECODE ONCE at startup to prevent "nested session" errors.
  # The tmux session inherits this from the parent Claude Code session.
  # Must happen here (not per-issue) because the first claude -p call
  # would see the inherited variable before per-issue unset takes effect.
  unset CLAUDECODE

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
  # Include labels so we can filter out failed/decomposed issues
  local issues
  issues=$("$GH" issue list \
    --repo "$REPO" \
    --label "approved" \
    --state open \
    --json number,title,body,labels \
    --search "sort:created-asc" \
    --limit 10 2>/dev/null || echo "[]")

  # Filter, priority-sort, and extract the first actionable issue as JSON
  # Priority: priority:high (0) > default (1) > priority:low (2), then oldest first
  # Uses JSON protocol to avoid newline-in-title corruption (HIGH-2 security fix)
  local first_issue_json
  first_issue_json=$(echo "$issues" | python3 -c "
import sys, json
SKIP_LABELS = {'failed', 'decomposed', 'in-progress'}
# Priority labels affect execution ORDER only, not authorization.
# The 'approved' label is the authorization gate. Private repo: all collaborators trusted.
PRIORITY_ORDER = {'priority:high': 0, 'priority:low': 2}
issues = json.load(sys.stdin)
candidates = []
for i in issues:
    labels = {l['name'] for l in i.get('labels', [])}
    if labels & SKIP_LABELS:
        continue
    priority_labels = [PRIORITY_ORDER[l] for l in labels if l in PRIORITY_ORDER]
    pri = min(priority_labels) if priority_labels else 1
    candidates.append((pri, i['number'], i))
candidates.sort(key=lambda x: (x[0], x[1]))
if candidates:
    i = candidates[0][2]
    out = json.dumps({'num': i['number'], 'title': i['title'], 'body': i.get('body') or '(no description)'})
    print(out)
" 2>/dev/null || echo "")

  if [ -z "$first_issue_json" ]; then
    return
  fi

  local issue_num issue_title issue_body
  issue_num=$(echo "$first_issue_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['num'])" 2>/dev/null)
  issue_title=$(echo "$first_issue_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])" 2>/dev/null)
  issue_body=$(echo "$first_issue_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['body'])" 2>/dev/null)

  # Validate issue_num is an integer
  if ! [[ "$issue_num" =~ ^[0-9]+$ ]]; then
    log "ERROR: Invalid issue number '$issue_num', skipping"
    return
  fi

  # Circuit breaker: pause after consecutive failures
  local failure_count
  failure_count=$(read_failure_count)
  if [ "$failure_count" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
    local state
    state=$(read_state)
    if [ "$state" != "paused-circuit-breaker" ]; then
      log "CIRCUIT BREAKER: $failure_count consecutive failures, pausing watcher"
      comment_issue "$issue_num" "Watcher paused after $failure_count consecutive failures. Run \`watcher.sh resume\` to reset and continue."
      write_state "paused-circuit-breaker"
    fi
    return
  fi

  log "Found actionable issue #$issue_num: $issue_title"
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

  # Prompt injection pre-filter: reject issues with suspicious patterns
  local INJECTION_PATTERNS='(ignore previous|disregard instructions|you are now|system prompt|override all|bypass security|forget your instructions|new persona)'
  if echo "$issue_body" | grep -qiE "$INJECTION_PATTERNS"; then
    log "REJECTED: Issue #$issue_num contains suspicious prompt patterns"
    fail_issue "$issue_num" "Issue body contains suspicious prompt patterns. Manual review required." "/dev/null" ""
    return
  fi

  # Effort scaling: adjust budget/turns/timeout based on priority labels
  local issue_labels
  issue_labels=$("$GH" issue view "$issue_num" --repo "$REPO" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")
  local eff_budget="$MAX_BUDGET"
  local eff_turns="$MAX_TURNS"
  local eff_timeout="$TIMEOUT"
  if echo "$issue_labels" | grep -q "priority:high"; then
    eff_budget="8.00"
    eff_turns="100"
    eff_timeout="10800"  # 3 hours
  elif echo "$issue_labels" | grep -q "priority:low"; then
    eff_budget="3.00"
    eff_turns="50"
    eff_timeout="3600"   # 1 hour
  fi

  log "Processing issue #$issue_num: $issue_title"
  log "Effort: budget=\$${eff_budget}, turns=$eff_turns, timeout=${eff_timeout}s"
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

  # Register prompt version for tracking (zero-cost, uses prompt-registry.ts)
  local prompt_template_content
  prompt_template_content=$(cat "$PROMPT_TEMPLATE" 2>/dev/null || echo "")
  if [ -n "$prompt_template_content" ]; then
    node -e "
      import('$RADL_OPS_DIR/dist/knowledge/prompt-registry.js')
        .then(m => m.registerPromptVersion('watcher-prompt', process.argv[1]))
        .catch(() => {})
    " "$prompt_template_content" 2>>"$log_file" || true
  fi

  # Inject knowledge context from inverse bloom (zero-cost, ~200ms)
  # Cap issue_body to 4000 chars before passing (MEDIUM-1 security fix)
  local knowledge_ctx
  knowledge_ctx=$(node "$RADL_OPS_DIR/scripts/watcher-knowledge.mjs" "$issue_title" "${issue_body:0:4000}" 2>>"$log_file" || echo "")
  if [ -n "$knowledge_ctx" ]; then
    prompt="${prompt}
${knowledge_ctx}"
    log "Knowledge context injected ($(echo "$knowledge_ctx" | wc -l) lines)"
  else
    log "No knowledge context matched for this issue"
  fi

  # Run claude -p in background so we can check for cancel label
  log "Running claude -p for issue #$issue_num (timeout: ${eff_timeout}s, budget: \$${eff_budget})..."

  # Start in new process group so cancel can kill the entire tree
  setsid timeout "$eff_timeout" "$CLAUDE_BIN" -p "$prompt" \
    --max-turns "$eff_turns" \
    --permission-mode bypassPermissions \
    --max-budget-usd "$eff_budget" \
    >> "$log_file" 2>&1 &
  local claude_pid=$!

  # Monitor for cancel label while claude runs
  local claude_exit=0
  while kill -0 "$claude_pid" 2>/dev/null; do
    # Check if cancel label was added
    local labels
    labels=$("$GH" issue view "$issue_num" --repo "$REPO" --json labels --jq '.labels[].name' 2>/dev/null || echo "")
    if echo "$labels" | grep -q "^cancel$"; then
      log "CANCELLED: Issue #$issue_num cancelled via label"
      kill -TERM -"$claude_pid" 2>/dev/null || kill "$claude_pid" 2>/dev/null || true
      sleep 2
      kill -KILL -"$claude_pid" 2>/dev/null || true
      wait "$claude_pid" 2>/dev/null || true
      remove_label "$issue_num" "cancel"
      fail_issue "$issue_num" "Cancelled by user via \`cancel\` label." "$log_file" "$branch_name"
      return
    fi
    sleep 15
  done
  wait "$claude_pid" || claude_exit=$?

  # Check for late cancel (label added in last polling window after claude finished)
  local post_labels
  post_labels=$("$GH" issue view "$issue_num" --repo "$REPO" --json labels --jq '.labels[].name' 2>/dev/null || echo "")
  if echo "$post_labels" | grep -q "^cancel$"; then
    log "CANCELLED (late): Issue #$issue_num had cancel label set after completion"
    remove_label "$issue_num" "cancel"
    fail_issue "$issue_num" "Cancelled by user via \`cancel\` label (late)." "$log_file" "$branch_name"
    return
  fi

  if [ "$claude_exit" -eq 124 ]; then
    log "TIMEOUT: Issue #$issue_num exceeded ${eff_timeout}s"
    fail_issue "$issue_num" "Execution timed out after ${eff_timeout}s. Partial work may exist on branch \`$branch_name\`." "$log_file" "$branch_name"
    return
  fi

  if [ "$claude_exit" -ne 0 ]; then
    log "FAILED: Claude exited with code $claude_exit for issue #$issue_num"
    fail_issue "$issue_num" "Claude exited with code $claude_exit. Check [watcher logs](branch: \`$branch_name\`)." "$log_file" "$branch_name"
    return
  fi

  # Check if Claude decomposed the issue into sub-issues instead of implementing
  # Search ALL comments (not just last) — Claude may post progress after the decompose summary
  local all_comments
  all_comments=$("$GH" issue view "$issue_num" --repo "$REPO" \
    --json comments --jq '[.comments[].body] | join("\n")' 2>/dev/null || echo "")
  if echo "$all_comments" | grep -qi "Decomposed into"; then
    log "DECOMPOSED: Issue #$issue_num was broken into sub-issues"

    # Guard against unbounded sub-issue fanout (budget protection)
    local subissue_count
    subissue_count=$("$GH" issue list --repo "$REPO" \
      --label "approved" --label "watcher" --state open \
      --json number --jq 'length' 2>/dev/null || echo "0")
    if [ "$subissue_count" -gt "$MAX_SUBISSUES" ]; then
      log "WARNING: Decompose created $subissue_count sub-issues (max $MAX_SUBISSUES)"
      comment_issue "$issue_num" "Warning: $subissue_count sub-issues queued (limit: $MAX_SUBISSUES). Watcher paused — review and remove excess \`approved\` labels before restarting."
      remove_label "$issue_num" "in-progress"
      add_label "$issue_num" "decomposed"
      cd "$RADL_DIR"
      git checkout main >> "$log_file" 2>&1 || true
      git branch -D "$branch_name" >> "$log_file" 2>&1 || true
      write_state "paused-decompose-overflow"
      return
    fi

    remove_label "$issue_num" "in-progress"
    remove_label "$issue_num" "approved"
    add_label "$issue_num" "decomposed"
    comment_issue "$issue_num" "Sub-issues created with \`approved\` label. The watcher will process them automatically."
    # Clean up branch — decompose doesn't produce commits
    cd "$RADL_DIR"
    git checkout main >> "$log_file" 2>&1 || true
    git branch -D "$branch_name" >> "$log_file" 2>&1 || true
    write_state "polling"
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

  # Build gate: verify typecheck passes before creating PR
  log "Running typecheck for issue #$issue_num..."
  local typecheck_ok=true
  npm run typecheck >> "$log_file" 2>&1 || typecheck_ok=false

  if [ "$typecheck_ok" = false ]; then
    log "WARNING: Typecheck failed for issue #$issue_num, PR will be created anyway"
    comment_issue "$issue_num" "Warning: \`npm run typecheck\` failed on this branch. PR created but may need fixes."
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

  # Extract and log cost from Claude CLI output (last few lines contain usage summary)
  local cost_line
  cost_line=$(tail -30 "$log_file" 2>/dev/null | grep -oP 'Total cost: \$[\d.]+' | tail -1 || echo "")
  local issue_cost="0"
  if [ -n "$cost_line" ]; then
    issue_cost=$(echo "$cost_line" | grep -oP '[\d.]+' || echo "0")
    local cost_date
    cost_date=$(date +%Y-%m-%d)
    echo "{\"date\":\"$cost_date\",\"issue\":$issue_num,\"cost_usd\":$issue_cost,\"branch\":\"$branch_name\"}" >> "$LOG_DIR/cost-summary.jsonl"
    log "Issue #$issue_num cost: \$$issue_cost"
  fi

  # Mark success — reset circuit breaker
  reset_failure_count
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

  # Circuit breaker: track consecutive failures (skip cancellations)
  if ! echo "$reason" | grep -qi "cancel"; then
    local new_count
    new_count=$(increment_failure_count)
    log "Failure count: $new_count / $MAX_CONSECUTIVE_FAILURES"
  fi

  remove_label "$issue_num" "in-progress"
  add_label "$issue_num" "failed"
  comment_issue "$issue_num" "Watcher failed: $reason"

  # Auto-create antibody from failure (skips cancellations)
  # Waits up to 30s then gives up — don't block cleanup indefinitely
  if ! echo "$reason" | grep -qi "cancel"; then
    node "$RADL_OPS_DIR/scripts/watcher-antibody.mjs" \
      "Watcher issue #$issue_num failed: $reason" \
      "watcher-issue-$issue_num" >> "$log_file" 2>&1 &
    local antibody_pid=$!
    log "Antibody creation started (pid $antibody_pid)"
    # Kill after 30s if still running, then wait for exit
    ( sleep 30 && kill "$antibody_pid" 2>/dev/null ) &
    local timeout_pid=$!
    wait "$antibody_pid" 2>/dev/null || true
    kill "$timeout_pid" 2>/dev/null || true
    log "Antibody creation complete"
  fi

  # Clean up: return to main and delete failed branch
  cd "$RADL_DIR"
  git checkout main >> "$log_file" 2>&1 || true
  git branch -D "$branch_name" >> "$log_file" 2>&1 || true

  write_state "polling"
}

cmd_resume() {
  local failures
  failures=$(read_failure_count)
  reset_failure_count
  write_state "polling"
  echo "Circuit breaker reset (was $failures consecutive failures)."
  echo "Watcher will resume processing on next poll cycle."
}

cmd_cancel() {
  # Find the currently in-progress issue and add the cancel label
  local active
  active=$("$GH" issue list --repo "$REPO" --label "in-progress" --state open \
    --json number,title --limit 1 2>/dev/null || echo "[]")
  local issue_num
  issue_num=$(echo "$active" | python3 -c "
import sys, json
issues = json.load(sys.stdin)
if issues:
    print(issues[0]['number'])
" 2>/dev/null || echo "")

  if [ -z "$issue_num" ]; then
    echo "No in-progress issue found. Nothing to cancel."
    return
  fi

  local title
  title=$(echo "$active" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['title'])" 2>/dev/null || echo "")
  echo "Cancelling issue #$issue_num: $title"
  add_label "$issue_num" "cancel"
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "Cancel label added. The watcher will stop processing within ~15 seconds."
  else
    echo "Cancel label added. Note: watcher is not running — start it with 'watcher.sh start' for the cancel to take effect."
  fi
}

cmd_webhook_handler() {
  # Process a GitHub webhook payload from stdin.
  # Accepts issues.labeled events with the "approved" label.
  # Usage: echo '{"action":"labeled","label":{"name":"approved"},...}' | watcher.sh webhook-handler
  local payload
  payload=$(cat)

  local action label_name
  action=$(echo "$payload" | python3 -c "import sys,json; print(json.load(sys.stdin).get('action',''))" 2>/dev/null || echo "")
  label_name=$(echo "$payload" | python3 -c "import sys,json; print(json.load(sys.stdin).get('label',{}).get('name',''))" 2>/dev/null || echo "")

  if [ "$action" != "labeled" ] || [ "$label_name" != "approved" ]; then
    echo "Ignored: action=$action label=$label_name (expected labeled + approved)"
    return
  fi

  local issue_num issue_title issue_body
  issue_num=$(echo "$payload" | python3 -c "import sys,json; print(json.load(sys.stdin).get('issue',{}).get('number',0))" 2>/dev/null || echo "0")
  issue_title=$(echo "$payload" | python3 -c "import sys,json; print(json.load(sys.stdin).get('issue',{}).get('title',''))" 2>/dev/null || echo "")
  issue_body=$(echo "$payload" | python3 -c "import sys,json; print(json.load(sys.stdin).get('issue',{}).get('body',''))" 2>/dev/null || echo "")

  if [ "$issue_num" = "0" ] || [ -z "$issue_title" ]; then
    echo "ERROR: Could not parse issue from webhook payload"
    return 1
  fi

  log "Webhook: received approved event for issue #$issue_num: $issue_title"
  process_issue "$issue_num" "$issue_title" "$issue_body"
}

# --- Main ---

case "${1:-help}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   cmd_logs ;;
  cancel) cmd_cancel ;;
  resume)          cmd_resume ;;
  run)             cmd_run ;;
  webhook-handler) cmd_webhook_handler ;;
  help|*)
    echo "Usage: watcher.sh <command>"
    echo ""
    echo "Commands:"
    echo "  start            — Launch watcher in tmux session"
    echo "  stop             — Kill the tmux session"
    echo "  status           — Show running state and queue depth"
    echo "  logs             — Tail the latest log file"
    echo "  cancel           — Cancel the currently in-progress issue"
    echo "  resume           — Reset circuit breaker and resume polling"
    echo "  run              — Run poll loop directly (used inside tmux)"
    echo "  webhook-handler  — Process a GitHub webhook payload from stdin"
    echo ""
    echo "Configuration (via .env or environment):"
    echo "  WATCHER_POLL_INTERVAL  Poll interval in seconds (default: 60)"
    echo "  WATCHER_MAX_TURNS      Max claude -p turns per issue (default: 75)"
    echo "  WATCHER_MAX_BUDGET     Max USD per issue (default: 5.00)"
    echo "  WATCHER_TIMEOUT        Max seconds per issue (default: 7200)"
    echo "  WATCHER_MAX_FAILURES   Consecutive failures before pause (default: 3)"
    echo "  WATCHER_REPO           GitHub owner/repo (default: Sn1ckerDood1e/Radl)"
    ;;
esac

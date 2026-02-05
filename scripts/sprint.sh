#!/bin/bash
# Sprint Management System (Python-based JSON, no jq required)
# Usage:
#   ./sprint.sh start "Phase 53.1" "Rigging Database" "3 hours"
#   ./sprint.sh task "Task description"
#   ./sprint.sh progress "Task completed"
#   ./sprint.sh blocker "Description of blocker"
#   ./sprint.sh checkpoint
#   ./sprint.sh complete "commit_hash" "actual_time"
#   ./sprint.sh status

set -e

# Load environment
source /home/hb/radl-ops/.env 2>/dev/null || true

SPRINT_DIR="/home/hb/radl/.planning/sprints"
CURRENT_SPRINT="$SPRINT_DIR/current.json"

mkdir -p "$SPRINT_DIR"

# Python JSON helper
json_get() {
  local file="$1"
  local key="$2"
  python3 -c "import json; print(json.load(open('$file')).get('$key', ''))"
}

json_get_len() {
  local file="$1"
  local key="$2"
  python3 -c "import json; print(len(json.load(open('$file')).get('$key', [])))"
}

json_update() {
  local file="$1"
  local updates="$2"
  python3 << EOF
import json
from datetime import datetime

with open('$file', 'r') as f:
    data = json.load(f)

# Apply updates
updates = $updates
for key, value in updates.items():
    if key.startswith('append_'):
        arr_key = key[7:]
        if arr_key not in data:
            data[arr_key] = []
        data[arr_key].append(value)
    else:
        data[key] = value

with open('$file', 'w') as f:
    json.dump(data, f, indent=2)
EOF
}

# Slack notification helper
notify_slack() {
  local message="$1"
  local blocks="$2"

  if [ -z "$SLACK_WEBHOOK_URL" ]; then
    echo "Warning: SLACK_WEBHOOK_URL not set, skipping notification"
    return
  fi

  if [ -n "$blocks" ]; then
    curl -s -X POST -H 'Content-type: application/json' --data "$blocks" "$SLACK_WEBHOOK_URL" > /dev/null
  else
    curl -s -X POST -H 'Content-type: application/json' --data "{\"text\": \"$message\"}" "$SLACK_WEBHOOK_URL" > /dev/null
  fi
}

# Start a new sprint
cmd_start() {
  local phase="$1"
  local title="$2"
  local estimate="$3"

  if [ -z "$phase" ] || [ -z "$title" ]; then
    echo "Usage: sprint.sh start <phase> <title> [estimate]"
    exit 1
  fi

  # Create sprint file
  local sprint_id=$(date '+%Y%m%d-%H%M%S')
  local start_time=$(date -Iseconds)

  cat > "$CURRENT_SPRINT" << EOF
{
  "id": "$sprint_id",
  "phase": "$phase",
  "title": "$title",
  "estimate": "$estimate",
  "startTime": "$start_time",
  "status": "in_progress",
  "tasks": [],
  "completedTasks": [],
  "blockers": [],
  "checkpoints": []
}
EOF

  echo "Sprint started: $phase - $title"
  echo "Estimate: $estimate"
  echo "Sprint ID: $sprint_id"

  # Send Slack notification
  notify_slack "" "{
    \"text\": \"🚀 Sprint Started: $phase - $title\",
    \"blocks\": [
      {
        \"type\": \"header\",
        \"text\": {
          \"type\": \"plain_text\",
          \"text\": \"🚀 Sprint Started\",
          \"emoji\": true
        }
      },
      {
        \"type\": \"section\",
        \"text\": {
          \"type\": \"mrkdwn\",
          \"text\": \"*$phase: $title*\n\n*Estimate:* $estimate\n*Started:* $(date '+%H:%M')\"
        }
      }
    ]
  }"
}

# Add a task to the sprint
cmd_task() {
  local description="$1"

  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint. Use 'sprint.sh start' first."
    exit 1
  fi

  local task_id=$(date '+%s')
  local now=$(date -Iseconds)

  json_update "$CURRENT_SPRINT" "{\"append_tasks\": {\"id\": \"$task_id\", \"description\": \"$description\", \"status\": \"pending\", \"addedAt\": \"$now\"}}"

  echo "Task added: $description"
}

# Mark progress on current sprint
cmd_progress() {
  local message="$1"

  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."
    exit 1
  fi

  local phase=$(json_get "$CURRENT_SPRINT" "phase")
  local title=$(json_get "$CURRENT_SPRINT" "title")
  local completed=$(json_get_len "$CURRENT_SPRINT" "completedTasks")
  local now=$(date -Iseconds)

  # Add to completed tasks
  json_update "$CURRENT_SPRINT" "{\"append_completedTasks\": {\"message\": \"$message\", \"completedAt\": \"$now\"}}"

  completed=$((completed + 1))

  echo "Progress: $message ($completed tasks done)"

  # Send Slack notification for milestone (every 3 tasks or significant progress)
  if [ $((completed % 3)) -eq 0 ] || [ "$2" = "--notify" ]; then
    notify_slack "" "{
      \"text\": \"📊 Sprint Progress: $phase\",
      \"blocks\": [
        {
          \"type\": \"section\",
          \"text\": {
            \"type\": \"mrkdwn\",
            \"text\": \"*$phase: $title*\n\n✅ $message\n\n*Progress:* $completed tasks completed\"
          }
        }
      ]
    }"
  fi
}

# Report a blocker
cmd_blocker() {
  local description="$1"

  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."
    exit 1
  fi

  local phase=$(json_get "$CURRENT_SPRINT" "phase")
  local title=$(json_get "$CURRENT_SPRINT" "title")
  local now=$(date -Iseconds)

  # Add blocker to sprint
  json_update "$CURRENT_SPRINT" "{\"append_blockers\": {\"description\": \"$description\", \"reportedAt\": \"$now\", \"resolved\": False}}"

  echo "Blocker reported: $description"

  # IMMEDIATELY notify Slack
  notify_slack "" "{
    \"text\": \"🚨 BLOCKER: $phase\",
    \"blocks\": [
      {
        \"type\": \"header\",
        \"text\": {
          \"type\": \"plain_text\",
          \"text\": \"🚨 Sprint Blocker\",
          \"emoji\": true
        }
      },
      {
        \"type\": \"section\",
        \"text\": {
          \"type\": \"mrkdwn\",
          \"text\": \"*$phase: $title*\n\n*Blocker:* $description\n\n*Time:* $(date '+%H:%M')\"
        }
      }
    ]
  }"
}

# Resolve a blocker
cmd_resolve() {
  local blocker_num="$1"

  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."
    exit 1
  fi

  if [ -z "$blocker_num" ]; then
    # List blockers with numbers
    echo "Active blockers:"
    python3 << EOF
import json
with open('$CURRENT_SPRINT', 'r') as f:
    data = json.load(f)
blockers = data.get('blockers', [])
for i, b in enumerate(blockers):
    status = "✅" if b.get('resolved', False) else "❌"
    print(f"  {i+1}. {status} {b['description']}")
if not blockers:
    print("  No blockers")
EOF
    echo ""
    echo "Usage: sprint.sh resolve <number>"
    exit 0
  fi

  # Mark blocker as resolved
  python3 << EOF
import json
with open('$CURRENT_SPRINT', 'r') as f:
    data = json.load(f)
idx = int('$blocker_num') - 1
if 0 <= idx < len(data.get('blockers', [])):
    data['blockers'][idx]['resolved'] = True
    data['blockers'][idx]['resolvedAt'] = '$(date -Iseconds)'
    with open('$CURRENT_SPRINT', 'w') as f:
        json.dump(data, f, indent=2)
    print(f"Blocker {int('$blocker_num')} resolved: {data['blockers'][idx]['description']}")
else:
    print(f"Invalid blocker number: $blocker_num")
    exit(1)
EOF
}

# Show sprint analytics
cmd_analytics() {
  echo "=== Sprint Analytics ==="
  echo ""

  python3 << 'EOF'
import json
import os
from datetime import datetime
from pathlib import Path

sprint_dir = Path('/home/hb/radl/.planning/sprints')
completed_files = sorted(sprint_dir.glob('completed-*.json'), reverse=True)

if not completed_files:
    print("No completed sprints found.")
    exit(0)

total_sprints = 0
total_tasks = 0
total_blockers = 0
estimates = []
actuals = []

for f in completed_files[:20]:  # Last 20 sprints
    try:
        with open(f, 'r') as file:
            data = json.load(file)
        total_sprints += 1
        total_tasks += len(data.get('completedTasks', []))
        total_blockers += len(data.get('blockers', []))

        # Parse times if available
        est = data.get('estimate', '')
        act = data.get('actualTime', '')
        if est and act:
            # Simple parsing for "X hours" or "X.X hours"
            try:
                est_hrs = float(est.split()[0])
                act_hrs = float(act.split()[0])
                estimates.append(est_hrs)
                actuals.append(act_hrs)
            except:
                pass
    except:
        pass

print(f"Sprints analyzed: {total_sprints}")
print(f"Total tasks completed: {total_tasks}")
print(f"Total blockers encountered: {total_blockers}")
print(f"Avg tasks per sprint: {total_tasks / total_sprints:.1f}")
print(f"Avg blockers per sprint: {total_blockers / total_sprints:.1f}")

if estimates and actuals:
    avg_est = sum(estimates) / len(estimates)
    avg_act = sum(actuals) / len(actuals)
    accuracy = (avg_act / avg_est) * 100 if avg_est > 0 else 0
    print(f"\nTime estimation:")
    print(f"  Avg estimated: {avg_est:.1f} hours")
    print(f"  Avg actual: {avg_act:.1f} hours")
    print(f"  Accuracy: {accuracy:.0f}% (100% = perfect)")

print("\nRecent sprints:")
for f in completed_files[:5]:
    try:
        with open(f, 'r') as file:
            data = json.load(file)
        phase = data.get('phase', 'Unknown')
        title = data.get('title', 'Unknown')
        est = data.get('estimate', '?')
        act = data.get('actualTime', '?')
        tasks = len(data.get('completedTasks', []))
        print(f"  - {phase}: {title}")
        print(f"    Est: {est} → Actual: {act} | Tasks: {tasks}")
    except:
        pass
EOF
}

# Save a checkpoint
cmd_checkpoint() {
  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."
    exit 1
  fi

  local checkpoint_time=$(date -Iseconds)
  local phase=$(json_get "$CURRENT_SPRINT" "phase")
  local completed=$(json_get_len "$CURRENT_SPRINT" "completedTasks")

  # Add checkpoint
  json_update "$CURRENT_SPRINT" "{\"append_checkpoints\": {\"time\": \"$checkpoint_time\", \"completedTasks\": $completed}}"

  # Also copy to archive
  local sprint_id=$(json_get "$CURRENT_SPRINT" "id")
  cp "$CURRENT_SPRINT" "$SPRINT_DIR/checkpoint-$sprint_id-$(date '+%H%M%S').json"

  echo "Checkpoint saved at $checkpoint_time ($completed tasks completed)"
}

# Complete the sprint
cmd_complete() {
  local commit="$1"
  local actual_time="$2"

  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."
    exit 1
  fi

  local phase=$(json_get "$CURRENT_SPRINT" "phase")
  local title=$(json_get "$CURRENT_SPRINT" "title")
  local estimate=$(json_get "$CURRENT_SPRINT" "estimate")
  local sprint_id=$(json_get "$CURRENT_SPRINT" "id")
  local completed=$(json_get_len "$CURRENT_SPRINT" "completedTasks")
  local blockers=$(json_get_len "$CURRENT_SPRINT" "blockers")
  local end_time=$(date -Iseconds)

  # Update sprint status
  json_update "$CURRENT_SPRINT" "{\"status\": \"completed\", \"commit\": \"$commit\", \"actualTime\": \"$actual_time\", \"endTime\": \"$end_time\"}"

  # Move to archive
  mv "$CURRENT_SPRINT" "$SPRINT_DIR/completed-$sprint_id.json"

  echo "Sprint completed!"
  echo "  Phase: $phase"
  echo "  Title: $title"
  echo "  Commit: $commit"
  echo "  Estimated: $estimate"
  echo "  Actual: $actual_time"
  echo "  Tasks: $completed"
  echo "  Blockers: $blockers"

  # Send completion notification
  notify_slack "" "{
    \"text\": \"✅ Sprint Complete: $phase - $title\",
    \"blocks\": [
      {
        \"type\": \"header\",
        \"text\": {
          \"type\": \"plain_text\",
          \"text\": \"✅ Sprint Complete\",
          \"emoji\": true
        }
      },
      {
        \"type\": \"section\",
        \"text\": {
          \"type\": \"mrkdwn\",
          \"text\": \"*$phase: $title*\n\n*Commit:* \`$commit\`\n*Time:* $actual_time (estimated $estimate)\n*Tasks:* $completed completed\n*Blockers:* $blockers\"
        }
      },
      {
        \"type\": \"context\",
        \"elements\": [
          {
            \"type\": \"mrkdwn\",
            \"text\": \"Deployed to production via Vercel • $(date '+%Y-%m-%d %H:%M')\"
          }
        ]
      }
    ]
  }"
}

# Show current sprint status
cmd_status() {
  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."

    # Show recent completed sprints
    echo ""
    echo "Recent completed sprints:"
    for f in $(ls -t "$SPRINT_DIR"/completed-*.json 2>/dev/null | head -5); do
      local phase=$(json_get "$f" "phase")
      local title=$(json_get "$f" "title")
      local actual=$(json_get "$f" "actualTime")
      echo "  - $phase: $title ($actual)"
    done
    exit 0
  fi

  local phase=$(json_get "$CURRENT_SPRINT" "phase")
  local title=$(json_get "$CURRENT_SPRINT" "title")
  local estimate=$(json_get "$CURRENT_SPRINT" "estimate")
  local start=$(json_get "$CURRENT_SPRINT" "startTime")
  local completed=$(json_get_len "$CURRENT_SPRINT" "completedTasks")
  local blockers=$(json_get_len "$CURRENT_SPRINT" "blockers")

  echo "=== Current Sprint ==="
  echo "Phase: $phase"
  echo "Title: $title"
  echo "Estimate: $estimate"
  echo "Started: $start"
  echo "Tasks: $completed completed"
  echo "Active blockers: $blockers"

  if [ "$blockers" -gt 0 ]; then
    echo ""
    echo "Blockers:"
    python3 << EOF
import json
with open('$CURRENT_SPRINT', 'r') as f:
    data = json.load(f)
for b in data.get('blockers', []):
    if not b.get('resolved', False):
        print(f"  - {b['description']}")
EOF
  fi
}

# Main command router
case "$1" in
  start) cmd_start "$2" "$3" "$4" ;;
  task) cmd_task "$2" ;;
  progress) cmd_progress "$2" "$3" ;;
  blocker) cmd_blocker "$2" ;;
  resolve) cmd_resolve "$2" ;;
  checkpoint) cmd_checkpoint ;;
  complete) cmd_complete "$2" "$3" ;;
  status) cmd_status ;;
  analytics) cmd_analytics ;;
  *)
    echo "Sprint Management System"
    echo ""
    echo "Usage: sprint.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  start <phase> <title> [estimate]  Start a new sprint"
    echo "  task <description>                Add a task to current sprint"
    echo "  progress <message> [--notify]     Record task completion"
    echo "  blocker <description>             Report a blocker (notifies Slack immediately)"
    echo "  resolve [number]                  List blockers or resolve one by number"
    echo "  checkpoint                        Save sprint state checkpoint"
    echo "  complete <commit> <actual_time>   Complete the sprint"
    echo "  status                            Show current sprint status"
    echo "  analytics                         Show sprint analytics and trends"
    ;;
esac

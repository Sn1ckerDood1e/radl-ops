#!/bin/bash
# Sprint Management System
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
  local updated=$(jq --arg desc "$description" --arg id "$task_id" \
    '.tasks += [{"id": $id, "description": $desc, "status": "pending", "addedAt": (now | todate)}]' \
    "$CURRENT_SPRINT")

  echo "$updated" > "$CURRENT_SPRINT"
  echo "Task added: $description"
}

# Mark progress on current sprint
cmd_progress() {
  local message="$1"

  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."
    exit 1
  fi

  local phase=$(jq -r '.phase' "$CURRENT_SPRINT")
  local title=$(jq -r '.title' "$CURRENT_SPRINT")
  local completed=$(jq -r '.completedTasks | length' "$CURRENT_SPRINT")
  local total=$(jq -r '.tasks | length' "$CURRENT_SPRINT")

  # Add to completed tasks
  local updated=$(jq --arg msg "$message" \
    '.completedTasks += [{"message": $msg, "completedAt": (now | todate)}]' \
    "$CURRENT_SPRINT")
  echo "$updated" > "$CURRENT_SPRINT"

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

  local phase=$(jq -r '.phase' "$CURRENT_SPRINT")
  local title=$(jq -r '.title' "$CURRENT_SPRINT")

  # Add blocker to sprint
  local updated=$(jq --arg desc "$description" \
    '.blockers += [{"description": $desc, "reportedAt": (now | todate), "resolved": false}]' \
    "$CURRENT_SPRINT")
  echo "$updated" > "$CURRENT_SPRINT"

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

# Save a checkpoint
cmd_checkpoint() {
  if [ ! -f "$CURRENT_SPRINT" ]; then
    echo "No active sprint."
    exit 1
  fi

  local checkpoint_time=$(date -Iseconds)
  local phase=$(jq -r '.phase' "$CURRENT_SPRINT")
  local completed=$(jq -r '.completedTasks | length' "$CURRENT_SPRINT")

  # Add checkpoint
  local updated=$(jq --arg time "$checkpoint_time" --arg tasks "$completed" \
    '.checkpoints += [{"time": $time, "completedTasks": ($tasks | tonumber)}]' \
    "$CURRENT_SPRINT")
  echo "$updated" > "$CURRENT_SPRINT"

  # Also copy to archive
  local sprint_id=$(jq -r '.id' "$CURRENT_SPRINT")
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

  local phase=$(jq -r '.phase' "$CURRENT_SPRINT")
  local title=$(jq -r '.title' "$CURRENT_SPRINT")
  local estimate=$(jq -r '.estimate' "$CURRENT_SPRINT")
  local sprint_id=$(jq -r '.id' "$CURRENT_SPRINT")
  local completed=$(jq -r '.completedTasks | length' "$CURRENT_SPRINT")
  local blockers=$(jq -r '.blockers | length' "$CURRENT_SPRINT")

  # Update sprint status
  local updated=$(jq --arg commit "$commit" --arg actual "$actual_time" \
    '.status = "completed" | .commit = $commit | .actualTime = $actual | .endTime = (now | todate)' \
    "$CURRENT_SPRINT")

  # Move to archive
  echo "$updated" > "$SPRINT_DIR/completed-$sprint_id.json"
  rm "$CURRENT_SPRINT"

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
    ls -t "$SPRINT_DIR"/completed-*.json 2>/dev/null | head -5 | while read f; do
      local phase=$(jq -r '.phase' "$f")
      local title=$(jq -r '.title' "$f")
      local actual=$(jq -r '.actualTime' "$f")
      echo "  - $phase: $title ($actual)"
    done
    exit 0
  fi

  local phase=$(jq -r '.phase' "$CURRENT_SPRINT")
  local title=$(jq -r '.title' "$CURRENT_SPRINT")
  local estimate=$(jq -r '.estimate' "$CURRENT_SPRINT")
  local start=$(jq -r '.startTime' "$CURRENT_SPRINT")
  local completed=$(jq -r '.completedTasks | length' "$CURRENT_SPRINT")
  local total=$(jq -r '.tasks | length' "$CURRENT_SPRINT")
  local blockers=$(jq -r '.blockers | map(select(.resolved == false)) | length' "$CURRENT_SPRINT")

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
    jq -r '.blockers | map(select(.resolved == false)) | .[] | "  - \(.description)"' "$CURRENT_SPRINT"
  fi
}

# Main command router
case "$1" in
  start) cmd_start "$2" "$3" "$4" ;;
  task) cmd_task "$2" ;;
  progress) cmd_progress "$2" "$3" ;;
  blocker) cmd_blocker "$2" ;;
  checkpoint) cmd_checkpoint ;;
  complete) cmd_complete "$2" "$3" ;;
  status) cmd_status ;;
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
    echo "  checkpoint                        Save sprint state checkpoint"
    echo "  complete <commit> <actual_time>   Complete the sprint"
    echo "  status                            Show current sprint status"
    ;;
esac

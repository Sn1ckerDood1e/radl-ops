#!/bin/bash
# Create GitHub labels required by the radl-ops issue watcher system.
# Run once: bash /home/hb/radl-ops/scripts/setup-labels.sh
#
# Idempotent — safe to run multiple times (uses --force to update existing labels).

set -euo pipefail

REPO="${WATCHER_REPO:-Sn1ckerDood1e/Radl}"
GH="${GH_BIN:-$(command -v gh || echo "$HOME/.local/bin/gh")}"

if [ ! -x "$GH" ]; then
  echo "ERROR: gh CLI not found. Install from https://cli.github.com/"
  exit 1
fi

echo "Creating watcher labels on $REPO..."

create_label() {
  local name="$1"
  local color="$2"
  local desc="$3"
  "$GH" label create "$name" --color "$color" --description "$desc" --repo "$REPO" --force
  echo "  ✓ $name"
}

create_label "approved"    "0E8A16" "User approves for autonomous execution"
create_label "in-progress" "FBCA04" "Watcher is working on this issue"
create_label "completed"   "0075CA" "Done — PR created"
create_label "failed"      "D73A4A" "Autonomous execution failed"
create_label "draft"       "E4E669" "Created by briefing, awaiting approval"
create_label "hold"        "F9D0C4" "Prevent auto-merge"
create_label "watcher"     "BFD4F2" "Created/managed by watcher system"
create_label "cancel"         "D93F0B" "Cancel in-progress watcher execution"
create_label "decomposed"     "1D76DB" "Issue broken into sub-issues by watcher"
# Priority labels affect execution ORDER only, not authorization (approved label is the gate).
# On a public repo, restrict who can apply these via repository settings.
create_label "priority:high"  "B60205" "Execute before default-priority issues"
create_label "priority:low"   "C5DEF5" "Execute after default-priority issues"

echo "Done. Labels created on $REPO."

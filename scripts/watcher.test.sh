#!/bin/bash
# Tests for the watcher system
# Usage: bash scripts/watcher.test.sh
#
# Tests prompt rendering, label script, and edge cases.
# Does NOT require GitHub access or claude CLI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RADL_OPS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
TOTAL=0

# --- Test helpers ---

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    echo "    actual: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo "  FAIL: $label"
    echo "    should NOT contain: $needle"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

# --- Test: Prompt template rendering ---

echo "=== Prompt Template Rendering ==="

TEMPLATE="$SCRIPT_DIR/watcher-prompt.md"

# Basic variable substitution
rendered=$(sed \
  -e "s|{{ISSUE_NUM}}|42|g" \
  -e "s|{{ISSUE_TITLE}}|Add dark mode|g" \
  -e "s|{{BRANCH_NAME}}|auto/issue-42-add-dark-mode|g" \
  "$TEMPLATE" | \
  awk -v body="Implement dark mode toggle in settings." '{gsub(/\{\{ISSUE_BODY\}\}/, body); print}')

assert_contains "issue number substituted" "Issue #42" "$rendered"
assert_contains "issue title substituted" "Add dark mode" "$rendered"
assert_contains "branch name substituted" "auto/issue-42-add-dark-mode" "$rendered"
assert_contains "body substituted" "Implement dark mode toggle" "$rendered"
assert_not_contains "no leftover template vars" "{{" "$rendered"

# Empty body handling
rendered_empty=$(sed \
  -e "s|{{ISSUE_NUM}}|1|g" \
  -e "s|{{ISSUE_TITLE}}|Fix bug|g" \
  -e "s|{{BRANCH_NAME}}|auto/issue-1-fix-bug|g" \
  "$TEMPLATE" | \
  awk -v body="(no description)" '{gsub(/\{\{ISSUE_BODY\}\}/, body); print}')

assert_contains "empty body shows placeholder" "(no description)" "$rendered_empty"
assert_not_contains "no leftover vars in empty body" "{{" "$rendered_empty"

# Special characters in title
rendered_special=$(sed \
  -e "s|{{ISSUE_NUM}}|99|g" \
  -e 's|{{ISSUE_TITLE}}|Fix "quotes" \& ampersands|g' \
  -e "s|{{BRANCH_NAME}}|auto/issue-99-fix-quotes|g" \
  "$TEMPLATE" | \
  awk -v body="Test body" '{gsub(/\{\{ISSUE_BODY\}\}/, body); print}')

assert_contains "special chars in title" "Issue #99" "$rendered_special"
assert_not_contains "no leftover vars with special chars" "{{" "$rendered_special"

# --- Test: Slugify function ---

echo ""
echo "=== Slugify Function ==="

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-50
}

assert_eq "basic title" "add-dark-mode" "$(slugify "Add dark mode")"
assert_eq "special chars" "fix-the-bug-in-auth" "$(slugify "Fix the bug in auth!")"
assert_eq "multiple spaces" "a-b-c" "$(slugify "A   B   C")"
assert_eq "unicode/symbols stripped" "fix-200-error" "$(slugify 'Fix $200 error')"

# Long title truncation (>50 chars)
long_slug=$(slugify "This is a very long issue title that exceeds fifty characters easily by a lot")
assert_eq "long title truncated to 50 chars" "50" "${#long_slug}"

# --- Test: Watcher help output ---

echo ""
echo "=== Watcher CLI ==="

help_output=$("$SCRIPT_DIR/watcher.sh" help 2>&1 || true)

assert_contains "help shows start" "start" "$help_output"
assert_contains "help shows stop" "stop" "$help_output"
assert_contains "help shows status" "status" "$help_output"
assert_contains "help shows logs" "logs" "$help_output"
assert_contains "help shows config" "WATCHER_POLL_INTERVAL" "$help_output"

# --- Test: Setup labels script structure ---

echo ""
echo "=== Setup Labels Script ==="

labels_script=$(cat "$SCRIPT_DIR/setup-labels.sh")

assert_contains "creates approved label" "approved" "$labels_script"
assert_contains "creates in-progress label" "in-progress" "$labels_script"
assert_contains "creates completed label" "completed" "$labels_script"
assert_contains "creates failed label" "failed" "$labels_script"
assert_contains "creates draft label" "draft" "$labels_script"
assert_contains "creates hold label" "hold" "$labels_script"
assert_contains "creates watcher label" "watcher" "$labels_script"
assert_contains "uses --force for idempotency" "--force" "$labels_script"

# --- Test: Cron setup includes watcher ---

echo ""
echo "=== Cron Setup ==="

cron_script=$(cat "$SCRIPT_DIR/cron-setup.sh")

assert_contains "cron includes watcher start" "watcher.sh start" "$cron_script"
assert_contains "cron has 30s boot delay" "sleep 30" "$cron_script"

# --- Summary ---

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "==================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

#!/bin/bash
# Service Health Check Script (Python-based JSON parsing, no jq required)
# Checks GitHub, Vercel, Supabase, and Sentry status
# Usage: ./health-check.sh [--json]

set -e

# Resolve directories
RADL_OPS_DIR="${RADL_OPS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

# Load environment
source "$RADL_OPS_DIR/.env" 2>/dev/null || true

JSON_OUTPUT=false
if [ "$1" = "--json" ]; then
  JSON_OUTPUT=true
fi

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() {
  local service="$1"
  local status="$2"
  local details="$3"

  if [ "$JSON_OUTPUT" = true ]; then
    echo "{\"service\": \"$service\", \"status\": \"$status\", \"details\": \"$details\"}"
  else
    case "$status" in
      "OK") echo -e "${GREEN}✓${NC} $service: $details" ;;
      "WARN") echo -e "${YELLOW}⚠${NC} $service: $details" ;;
      "ERROR") echo -e "${RED}✗${NC} $service: $details" ;;
    esac
  fi
}

# Python JSON helper
json_get() {
  local json="$1"
  local path="$2"
  echo "$json" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = data
    for key in '$path'.split('.'):
        if key.isdigit():
            result = result[int(key)]
        elif key and result:
            result = result.get(key, '')
    print(result if result else '')
except:
    print('')
" 2>/dev/null
}

json_len() {
  local json="$1"
  echo "$json" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(len(data) if isinstance(data, list) else 0)
except:
    print(0)
" 2>/dev/null
}

echo "=== Radl Service Health Check ==="
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- GitHub ---
echo "### GitHub ###"
if command -v gh &> /dev/null; then
  # Check rate limit
  RATE_RESPONSE=$(gh api rate_limit 2>/dev/null || echo '{}')
  RATE=$(json_get "$RATE_RESPONSE" "resources.core.remaining")
  RATE=${RATE:-0}

  if [ "$RATE" -gt 100 ] 2>/dev/null; then
    print_status "GitHub API" "OK" "Rate limit: $RATE remaining"
  else
    print_status "GitHub API" "WARN" "Low rate limit: $RATE remaining"
  fi

  # Check for failed CI
  RUNS_RESPONSE=$(gh run list --repo Sn1ckerDood1e/Radl --status failure --limit 5 --json conclusion 2>/dev/null || echo '[]')
  FAILED_RUNS=$(json_len "$RUNS_RESPONSE")

  if [ "$FAILED_RUNS" -gt 0 ] 2>/dev/null; then
    print_status "CI Status" "WARN" "$FAILED_RUNS recent failures"
  else
    print_status "CI Status" "OK" "No recent failures"
  fi

  # Open issues count
  ISSUES_RESPONSE=$(gh issue list --repo Sn1ckerDood1e/Radl --state open --limit 100 --json number 2>/dev/null || echo '[]')
  ISSUES=$(json_len "$ISSUES_RESPONSE")
  print_status "Open Issues" "OK" "$ISSUES open"
else
  print_status "GitHub" "ERROR" "gh CLI not installed"
fi
echo ""

# --- Vercel ---
echo "### Vercel ###"
if [ -n "$VERCEL_TOKEN" ]; then
  # Get latest deployment
  DEPLOY_RESPONSE=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v6/deployments?limit=1&projectId=${VERCEL_PROJECT_ID}" 2>/dev/null)

  DEPLOY_STATE=$(json_get "$DEPLOY_RESPONSE" "deployments.0.state")
  DEPLOY_URL=$(json_get "$DEPLOY_RESPONSE" "deployments.0.url")

  case "$DEPLOY_STATE" in
    "READY") print_status "Latest Deploy" "OK" "$DEPLOY_STATE - $DEPLOY_URL" ;;
    "ERROR"|"CANCELED") print_status "Latest Deploy" "ERROR" "$DEPLOY_STATE" ;;
    "") print_status "Latest Deploy" "WARN" "Unable to fetch" ;;
    *) print_status "Latest Deploy" "WARN" "$DEPLOY_STATE" ;;
  esac
else
  print_status "Vercel" "WARN" "VERCEL_TOKEN not configured"
fi
echo ""

# --- Supabase ---
echo "### Supabase ###"
if [ -n "$SUPABASE_ACCESS_TOKEN" ] && [ -n "$SUPABASE_PROJECT_ID" ]; then
  # Check project health
  PROJECT_RESPONSE=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID" 2>/dev/null)

  HEALTH=$(json_get "$PROJECT_RESPONSE" "status")

  if [ "$HEALTH" = "ACTIVE_HEALTHY" ]; then
    print_status "Project Status" "OK" "$HEALTH"
  elif [ -n "$HEALTH" ]; then
    print_status "Project Status" "WARN" "$HEALTH"
  else
    print_status "Project Status" "WARN" "Unable to fetch"
  fi

  # Check security advisors
  SEC_RESPONSE=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID/advisors/security" 2>/dev/null)
  SEC_COUNT=$(json_len "$SEC_RESPONSE")

  if [ "$SEC_COUNT" -gt 0 ] 2>/dev/null; then
    print_status "Security Advisors" "WARN" "$SEC_COUNT items need attention"
  else
    print_status "Security Advisors" "OK" "No issues"
  fi

  # Check performance advisors
  PERF_RESPONSE=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID/advisors/performance" 2>/dev/null)
  PERF_COUNT=$(json_len "$PERF_RESPONSE")

  if [ "$PERF_COUNT" -gt 0 ] 2>/dev/null; then
    print_status "Performance Advisors" "WARN" "$PERF_COUNT suggestions"
  else
    print_status "Performance Advisors" "OK" "No issues"
  fi
else
  print_status "Supabase" "WARN" "SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_ID not configured"
fi
echo ""

# --- Sentry ---
echo "### Sentry ###"
if [ -n "$SENTRY_AUTH_TOKEN" ] && [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ]; then
  # Get unresolved issues from last 24h
  ISSUES_RESPONSE=$(curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    "https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/issues/?query=is:unresolved+lastSeen:-24h" 2>/dev/null)

  ISSUE_COUNT=$(json_len "$ISSUES_RESPONSE")

  if [ "$ISSUE_COUNT" -gt 0 ] 2>/dev/null; then
    print_status "Unresolved Issues (24h)" "WARN" "$ISSUE_COUNT new issues"
    # Show top 3 issues
    echo "$ISSUES_RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        for issue in data[:3]:
            title = issue.get('title', 'Unknown')[:60]
            count = issue.get('count', 0)
            print(f'    - {title} ({count} events)')
except:
    pass
" 2>/dev/null
  else
    print_status "Unresolved Issues (24h)" "OK" "No new issues"
  fi

  # Get error rate
  STATS_RESPONSE=$(curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    "https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/stats/?stat=received&resolution=1d" 2>/dev/null)

  TODAY_ERRORS=$(echo "$STATS_RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data[-1][1] if data else 0)
except:
    print(0)
" 2>/dev/null)
  print_status "Events Today" "OK" "$TODAY_ERRORS events"
else
  print_status "Sentry" "WARN" "SENTRY_AUTH_TOKEN, SENTRY_ORG, or SENTRY_PROJECT not configured"
fi
echo ""

echo "=== Health Check Complete ==="

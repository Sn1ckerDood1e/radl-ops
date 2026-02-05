#!/bin/bash
# Service Health Check Script
# Checks GitHub, Vercel, and Supabase status
# Usage: ./health-check.sh [--json]

set -e

# Load environment
source /home/hb/radl-ops/.env 2>/dev/null || true

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

echo "=== Radl Service Health Check ==="
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- GitHub ---
echo "### GitHub ###"
if command -v gh &> /dev/null; then
  # Check rate limit
  RATE=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo "0")
  if [ "$RATE" -gt 100 ]; then
    print_status "GitHub API" "OK" "Rate limit: $RATE remaining"
  else
    print_status "GitHub API" "WARN" "Low rate limit: $RATE remaining"
  fi

  # Check for failed CI
  FAILED_RUNS=$(gh run list --repo Sn1ckerDood1e/Radl --status failure --limit 5 --json conclusion 2>/dev/null | jq 'length')
  if [ "$FAILED_RUNS" -gt 0 ]; then
    print_status "CI Status" "WARN" "$FAILED_RUNS recent failures"
  else
    print_status "CI Status" "OK" "No recent failures"
  fi

  # Open issues count
  ISSUES=$(gh issue list --repo Sn1ckerDood1e/Radl --state open --limit 100 --json number 2>/dev/null | jq 'length')
  print_status "Open Issues" "OK" "$ISSUES open"

  # Stale issues (>7 days)
  STALE=$(gh issue list --repo Sn1ckerDood1e/Radl --state open --json number,updatedAt 2>/dev/null | jq '[.[] | select(.updatedAt < (now - 7*24*60*60 | todate))] | length')
  if [ "$STALE" -gt 0 ]; then
    print_status "Stale Issues" "WARN" "$STALE issues not updated in 7+ days"
  else
    print_status "Stale Issues" "OK" "None"
  fi
else
  print_status "GitHub" "ERROR" "gh CLI not installed"
fi
echo ""

# --- Vercel ---
echo "### Vercel ###"
if [ -n "$VERCEL_TOKEN" ]; then
  # Get latest deployment
  DEPLOY_RESPONSE=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v6/deployments?limit=1&projectId=${VERCEL_PROJECT_ID:-prj_radl}" 2>/dev/null)

  DEPLOY_STATE=$(echo "$DEPLOY_RESPONSE" | jq -r '.deployments[0].state // "unknown"')
  DEPLOY_URL=$(echo "$DEPLOY_RESPONSE" | jq -r '.deployments[0].url // "unknown"')

  case "$DEPLOY_STATE" in
    "READY") print_status "Latest Deploy" "OK" "$DEPLOY_STATE - $DEPLOY_URL" ;;
    "ERROR"|"CANCELED") print_status "Latest Deploy" "ERROR" "$DEPLOY_STATE" ;;
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
  HEALTH=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID" 2>/dev/null | jq -r '.status // "unknown"')

  if [ "$HEALTH" = "ACTIVE_HEALTHY" ]; then
    print_status "Project Status" "OK" "$HEALTH"
  else
    print_status "Project Status" "WARN" "$HEALTH"
  fi

  # Check security advisors
  SEC_COUNT=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID/advisors/security" 2>/dev/null | jq 'length')

  if [ "$SEC_COUNT" -gt 0 ]; then
    print_status "Security Advisors" "WARN" "$SEC_COUNT items need attention"
  else
    print_status "Security Advisors" "OK" "No issues"
  fi

  # Check performance advisors
  PERF_COUNT=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID/advisors/performance" 2>/dev/null | jq 'length')

  if [ "$PERF_COUNT" -gt 0 ]; then
    print_status "Performance Advisors" "WARN" "$PERF_COUNT suggestions"
  else
    print_status "Performance Advisors" "OK" "No issues"
  fi
else
  print_status "Supabase" "WARN" "SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_ID not configured"
fi
echo ""

echo "=== Health Check Complete ==="

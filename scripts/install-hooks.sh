#!/bin/bash
# Install git hooks for the Radl repository
# Enforces iron laws at the git level
#
# Usage: ./install-hooks.sh

set -e

HOOKS_SRC="/home/hb/radl-ops/scripts/hooks"
RADL_HOOKS="/home/hb/radl/.git/hooks"

echo "Installing git hooks for Radl..."

# Pre-push hook (Iron Law #1: no push to main)
if [ -f "$HOOKS_SRC/pre-push" ]; then
  cp "$HOOKS_SRC/pre-push" "$RADL_HOOKS/pre-push"
  chmod +x "$RADL_HOOKS/pre-push"
  echo "  Installed: pre-push (blocks main/master push)"
fi

echo ""
echo "Hooks installed successfully."
echo "To bypass in emergencies: git push --no-verify"

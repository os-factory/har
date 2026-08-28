#!/usr/bin/env bash
# Baseline ("before") screenshots at session start — full verify captures the
# "after" set for visual proof. Lifted from the pre-1.0 adapted launch.sh
# (1.0 migration, #242). Failures warn, never block launch.
set -euo pipefail

if [ -f "$HAR_HARNESS_DIR/stages/capture-screenshots.sh" ] && [ -n "${HARNESS_HEALTH_CHECK_PATH:-}" ]; then
  echo "Capturing baseline (before) screenshots..."
  if ! "$HAR_HARNESS_DIR/stages/capture-screenshots.sh" "$AGENT_ID" before >/dev/null; then
    echo "Warning: baseline screenshots failed (install browsers with: npx playwright install chromium)." >&2
  fi
fi

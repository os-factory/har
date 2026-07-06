#!/usr/bin/env bash
# Sets up shared infrastructure for all iOS agent slots.
# Boots the target iOS Simulator if not already running. No Docker required
# for pure iOS apps — extend only when a local backend container is needed.
# Idempotent — safe to run multiple times.
#
# Usage: ./.har/setup-infra.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"

log() { echo "==> $*" >&2; }

# ── Xcode check ───────────────────────────────────────────────────────────────
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "Error: xcodebuild not found — install Xcode from the App Store." >&2
  exit 1
fi

XCODE_VERSION="$(xcodebuild -version 2>/dev/null | head -1 || echo 'Xcode (unknown)')"
log "Found: $XCODE_VERSION"

# ── Simulator ─────────────────────────────────────────────────────────────────
SIMULATOR_NAME="${HARNESS_SIMULATOR_NAME:-iPhone 16}"

log "Checking simulator: ${SIMULATOR_NAME}"

UDID="$(xcrun simctl list devices available 2>/dev/null \
  | grep "${SIMULATOR_NAME}" \
  | grep -E '\([A-F0-9-]{36}\)' \
  | head -1 \
  | grep -oE '[A-F0-9-]{36}' \
  | head -1 || true)"

if [ -z "$UDID" ]; then
  echo "Error: Simulator '${SIMULATOR_NAME}' not found in available devices." >&2
  echo "  Available simulators:" >&2
  xcrun simctl list devices available 2>/dev/null | grep -E 'iPhone|iPad' | head -20 >&2
  echo "  Update HARNESS_SIMULATOR_NAME in .har/harness.env." >&2
  exit 1
fi

STATE="$(xcrun simctl list devices 2>/dev/null \
  | grep "$UDID" \
  | grep -oE 'Booted|Shutdown|Unavailable' \
  | head -1 || echo "unknown")"

if [ "$STATE" = "Booted" ]; then
  log "Simulator '${SIMULATOR_NAME}' ($UDID) is already booted."
else
  log "Booting simulator '${SIMULATOR_NAME}' ($UDID)..."
  xcrun simctl boot "$UDID" 2>/dev/null || true

  log "Waiting for simulator to become ready..."
  for i in $(seq 1 30); do
    CURRENT="$(xcrun simctl list devices 2>/dev/null | grep "$UDID" | grep -oE 'Booted' | head -1 || true)"
    if [ "$CURRENT" = "Booted" ]; then
      log "Simulator is ready."
      break
    fi
    if [ "$i" = "30" ]; then
      echo "Warning: Simulator did not reach Booted state within 30 seconds." >&2
    fi
    sleep 1
  done
fi

# ── Optional Docker infra ─────────────────────────────────────────────────────
SERVICES="${HARNESS_INFRA_SERVICES:-}"
if [ -n "$SERVICES" ]; then
  COMPOSE_FILE="$SCRIPT_DIR/docker-compose.agent.yml"
  COMPOSE_PROJECT="har-${HARNESS_PROJECT_NAME}"
  log "Starting shared infrastructure (project: $COMPOSE_PROJECT): $SERVICES"
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d $SERVICES
fi

log ""
log "Infrastructure is ready."
log "  Simulator: ${SIMULATOR_NAME} ($UDID)"
har_infra_enabled mock-server && log "  Mock server: running (see docker-compose.agent.yml)"
exit 0

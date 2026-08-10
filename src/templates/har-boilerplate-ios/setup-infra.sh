#!/usr/bin/env bash
# Sets up shared infrastructure for all iOS agent slots.
# Checks the toolchain, and boots the configured simulator when slots share one
# (HARNESS_SIMULATOR_SHARED=true) — otherwise launch.sh boots each slot's own
# device. No Docker required for pure iOS apps — extend only when a local
# backend container is needed. Idempotent — safe to run multiple times.
#
# Usage: ./.har/setup-infra.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/simulator.sh"

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

if har_sim_per_slot_enabled; then
  # Each slot creates and boots its own device at launch — booting a shared one
  # here would only waste a device no slot is going to use. Resolve the model now
  # so a missing runtime is reported before any worktree is created.
  FAMILY="$(har_sim_preferred_family)"
  PLAN="$(har_sim_plan_creation "${HARNESS_SIMULATOR_NAME:-}" "$FAMILY")"
  PLAN_STATUS="${PLAN%%$'\t'*}"
  if [ "$PLAN_STATUS" = "OK" ]; then
    log "Per-slot simulators: launch creates one $(printf '%s' "$PLAN" | cut -f3) per agent."
  elif [ "$PLAN_STATUS" = "NO_MODEL" ] && [ -n "$(har_sim_device_by_name "${HARNESS_SIMULATOR_NAME:-}")" ]; then
    # Supported fallback: the name is an existing device rather than a model.
    log "Per-slot simulators: launch reuses the existing device '${SIMULATOR_NAME}'."
  else
    # Fail here rather than at launch, which would already have created a
    # worktree, a branch and an env file the user then has to tear down.
    echo "Error: no simulator can be prepared for '${SIMULATOR_NAME}'." >&2
    if [ "$PLAN" != "$PLAN_STATUS" ]; then
      echo "  Available ${FAMILY} models: ${PLAN#*$'\t'}" >&2
    else
      echo "  No iOS runtime is installed — add one in Xcode → Settings → Components." >&2
    fi
    echo "  Update HARNESS_SIMULATOR_NAME in .har/harness.env." >&2
    exit 1
  fi
else
  log "Checking simulator: ${SIMULATOR_NAME}"

  # Exact name match: a substring match on "iPhone 16" also hits "iPhone 16 Pro Max".
  RESOLVED="$(har_sim_resolve_configured)"
  UDID="${RESOLVED%%$'\t'*}"

  if [ -z "$UDID" ]; then
    echo "Error: Simulator '${SIMULATOR_NAME}' not found in available devices." >&2
    echo "  Available simulators:" >&2
    xcrun simctl list devices available 2>/dev/null | grep -E 'iPhone|iPad' | head -20 >&2
    echo "  Update HARNESS_SIMULATOR_NAME in .har/harness.env." >&2
    exit 1
  fi

  if [ "$(har_sim_device_state "$UDID")" = "Booted" ]; then
    log "Simulator '${SIMULATOR_NAME}' ($UDID) is already booted."
  else
    log "Booting simulator '${SIMULATOR_NAME}' ($UDID)..."
    if har_sim_boot "$UDID"; then
      log "Simulator is ready."
    else
      echo "Warning: Simulator did not reach Booted state." >&2
    fi
  fi
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
# In per-slot mode the device is reported by launch, once it exists.
if [ -n "${UDID:-}" ]; then
  log "  Simulator: ${SIMULATOR_NAME} ($UDID)"
fi
har_infra_enabled mock-server && log "  Mock server: running (see docker-compose.agent.yml)"
exit 0

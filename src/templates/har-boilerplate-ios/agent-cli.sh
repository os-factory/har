#!/usr/bin/env bash
# Namespaced CLI for managing an iOS mobile app agent slot.
#
# Usage: ./.har/agent-cli.sh <agent-id> <command> [args...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/simulator.sh"

AGENT_ID="${1:?Usage: agent-cli.sh <agent-id> <command> [args...]}"
COMMAND="${2:?Usage: agent-cli.sh <agent-id> <command> [args...]}"

validate_agent_id "$AGENT_ID"

WORKTREE_DIR="$(existing_slot_worktree "$AGENT_ID")"

# simctl target for this slot: its own device when one is reserved, else whatever
# is booted — never another slot's simulator.
slot_sim_target() {
  local claim udid
  claim="$(har_sim_claim_file "$AGENT_ID")"
  if [ -f "$claim" ]; then
    udid="$(read_slot_field "$claim" udid || true)"
    [ -n "$udid" ] && { echo "$udid"; return; }
  fi
  echo "booted"
}

resolve_work_dir() {
  local env_file
  env_file="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT")" || {
    echo "No active environment for agent ${AGENT_ID}" >&2
    har_suggest_launch "$AGENT_ID"
    exit 1
  }
  # shellcheck source=/dev/null
  source "$env_file"
  resolve_agent_work_dir "$env_file" "$AGENT_ID"
}

case "$COMMAND" in
  status)
    ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT" || true)"

    if [ -n "$ENV_FILE" ]; then
      # shellcheck source=/dev/null
      source "$ENV_FILE"
      echo "Agent ${AGENT_ID}: active"
      echo "  Work dir:  $(resolve_agent_work_dir "$ENV_FILE" "$AGENT_ID")"
      [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ] && echo "  Worktree:  $WORKTREE_DIR"
      echo "  Scheme:    ${HARNESS_XCODE_SCHEME:-not set}"
      echo "  Simulator: ${HARNESS_SIMULATOR_DEVICE_NAME:-${HARNESS_SIMULATOR_NAME:-not set}} ($(slot_sim_target))"
      echo "  Bundle ID: ${HARNESS_BUNDLE_ID:-not set}"
    else
      echo "No active environment for agent ${AGENT_ID}"
      har_suggest_launch "$AGENT_ID"
    fi
    ;;

  simulator)
    # Show the device reserved for this slot, or the configured one when idle.
    TARGET="$(slot_sim_target)"
    if [ "$TARGET" != "booted" ]; then
      echo "Simulator: $(har_sim_device_name "$TARGET") (${TARGET})"
      echo "State:     $(har_sim_device_state "$TARGET")"
      echo "Reserved:  $(har_sim_claim_file "$AGENT_ID")"
    else
      SIM_NAME="${HARNESS_SIMULATOR_NAME:-iPhone 16}"
      echo "Simulator: ${SIM_NAME} (no device reserved — the slot is not launched)"
      RESOLVED="$(har_sim_resolve_configured)"
      if [ -n "$RESOLVED" ]; then
        echo "Configured device: ${RESOLVED#*$'\t'} (${RESOLVED%%$'\t'*})"
      else
        echo "  (no matching simulator found — check HARNESS_SIMULATOR_NAME in harness.env)"
      fi
    fi
    ;;

  logs)
    echo "iOS profile has no managed processes." >&2
    echo "Use 'exec' to run project commands, or check Console.app for simulator logs." >&2
    exit 1
    ;;

  restart)
    echo "iOS profile has no managed processes to restart." >&2
    echo "Relaunch the slot or reinstall the app with:" >&2
    echo "  ./.har/agent-cli.sh ${AGENT_ID} install <path-to.app>" >&2
    exit 1
    ;;

  install)
    APP_PATH="${3:-}"
    if [ -z "$APP_PATH" ]; then
      echo "Usage: agent-cli.sh ${AGENT_ID} install <path-to.app>" >&2
      exit 1
    fi
    TARGET="$(slot_sim_target)"
    echo "==> Installing ${APP_PATH} on ${TARGET}..."
    xcrun simctl install "$TARGET" "$APP_PATH"
    echo "✓ Installed"
    ;;

  launch-app)
    BUNDLE="${3:-${HARNESS_BUNDLE_ID:-}}"
    if [ -z "$BUNDLE" ]; then
      echo "Usage: agent-cli.sh ${AGENT_ID} launch-app [bundle-id]" >&2
      echo "       or set HARNESS_BUNDLE_ID in harness.env" >&2
      exit 1
    fi
    TARGET="$(slot_sim_target)"
    echo "==> Launching ${BUNDLE} on ${TARGET}..."
    xcrun simctl launch "$TARGET" "$BUNDLE"
    ;;

  url)
    WORK_DIR="$(resolve_work_dir 2>/dev/null || echo "$REPO_ROOT")"
    echo "Work dir:  $WORK_DIR"
    [ -d "$WORKTREE_DIR" ] && echo "Worktree:  $WORKTREE_DIR"
    echo "Scheme:    ${HARNESS_XCODE_SCHEME:-not set}"
    echo "Simulator: ${HARNESS_SIMULATOR_DEVICE_NAME:-${HARNESS_SIMULATOR_NAME:-not set}} ($(slot_sim_target))"
    echo "Bundle ID: ${HARNESS_BUNDLE_ID:-not set}"
    har_infra_enabled mock-server && echo "Mock:      check docker-compose.agent.yml for port"
    ;;

  exec)
    shift 2
    if [ $# -eq 0 ]; then
      echo "Usage: agent-cli.sh ${AGENT_ID} exec <command>" >&2
      exit 1
    fi
    WORK_DIR="$(resolve_work_dir)"
    bash -c "cd '$WORK_DIR' && $*"
    ;;

  *)
    echo "Unknown command: $COMMAND" >&2
    echo ""
    echo "Commands: status, simulator, install <app>, launch-app [bundle-id], url, exec <cmd>"
    exit 1
    ;;
esac

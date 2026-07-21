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

AGENT_ID="${1:?Usage: agent-cli.sh <agent-id> <command> [args...]}"
COMMAND="${2:?Usage: agent-cli.sh <agent-id> <command> [args...]}"

validate_agent_id "$AGENT_ID"

WORKTREE_DIR="$(existing_slot_worktree "$AGENT_ID")"

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
      echo "  Simulator: ${HARNESS_SIMULATOR_NAME:-not set}"
      echo "  Bundle ID: ${HARNESS_BUNDLE_ID:-not set}"
    else
      echo "No active environment for agent ${AGENT_ID}"
      har_suggest_launch "$AGENT_ID"
    fi
    ;;

  simulator)
    # Show simulator state and UDID for the configured device.
    SIM_NAME="${HARNESS_SIMULATOR_NAME:-iPhone 16}"
    echo "Simulator: ${SIM_NAME}"
    xcrun simctl list devices available 2>/dev/null \
      | grep "${SIM_NAME}" \
      | grep -E '\([A-F0-9-]{36}\)' \
      | head -5 \
      || echo "  (no matching simulator found — check HARNESS_SIMULATOR_NAME in harness.env)"
    ;;

  logs)
    echo "iOS profile has no managed processes." >&2
    echo "Use 'exec' to run project commands, or check Console.app for simulator logs." >&2
    exit 1
    ;;

  restart)
    echo "iOS profile has no managed processes to restart." >&2
    echo "Relaunch the slot or reinstall the app with:" >&2
    echo "  ./.har/agent-cli.sh ${AGENT_ID} exec xcrun simctl install booted <path-to.app>" >&2
    exit 1
    ;;

  install)
    APP_PATH="${3:-}"
    if [ -z "$APP_PATH" ]; then
      echo "Usage: agent-cli.sh ${AGENT_ID} install <path-to.app>" >&2
      exit 1
    fi
    echo "==> Installing ${APP_PATH} on simulator..."
    xcrun simctl install booted "$APP_PATH"
    echo "✓ Installed"
    ;;

  launch-app)
    BUNDLE="${3:-${HARNESS_BUNDLE_ID:-}}"
    if [ -z "$BUNDLE" ]; then
      echo "Usage: agent-cli.sh ${AGENT_ID} launch-app [bundle-id]" >&2
      echo "       or set HARNESS_BUNDLE_ID in harness.env" >&2
      exit 1
    fi
    echo "==> Launching ${BUNDLE} on simulator..."
    xcrun simctl launch booted "$BUNDLE"
    ;;

  url)
    WORK_DIR="$(resolve_work_dir 2>/dev/null || echo "$REPO_ROOT")"
    echo "Work dir:  $WORK_DIR"
    [ -d "$WORKTREE_DIR" ] && echo "Worktree:  $WORKTREE_DIR"
    echo "Scheme:    ${HARNESS_XCODE_SCHEME:-not set}"
    echo "Simulator: ${HARNESS_SIMULATOR_NAME:-not set}"
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

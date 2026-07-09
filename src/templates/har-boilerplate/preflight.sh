#!/usr/bin/env bash
# Launch readiness gate — run before launch.sh or standalone.
# Usage: ./.har/preflight.sh <agent-id> [--replace] [--force]
# JSON:  har env preflight <id> --json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

AGENT_ID="${1:-}"
FORCE=false
REPLACE=false

for arg in "$@"; do
  case "$arg" in
    --replace) REPLACE=true ;;
    --force)   FORCE=true ;;
  esac
done

if [[ -z "$AGENT_ID" ]]; then
  echo "Usage: $0 <agent-id> [--replace] [--force]" >&2
  exit 1
fi

validate_agent_id "$AGENT_ID"

if har_launch_preflight "$AGENT_ID" "$FORCE" "$REPLACE"; then
  echo "Slot ${AGENT_ID}: ready to launch."
  if har_harness_uses_pm2; then
    echo "  Ports: frontend=${FE_PORT} api=${API_PORT} debug=${DEBUG_PORT}"
  fi
  exit 0
fi

exit $?

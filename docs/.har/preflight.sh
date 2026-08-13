#!/usr/bin/env bash
# Launch readiness gate — run before launch.sh or standalone.
# Usage: ./.har/preflight.sh <agent-id>
# JSON:  har env preflight <id> --json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

AGENT_ID="${1:-}"

if [[ -z "$AGENT_ID" ]]; then
  echo "Usage: $0 <agent-id>" >&2
  exit 1
fi

validate_agent_id "$AGENT_ID"

if har_launch_preflight "$AGENT_ID"; then
  echo "Slot ${AGENT_ID}: ready to launch."
  if har_harness_uses_pm2; then
    echo "  Ports: frontend=${FE_PORT} api=${API_PORT} debug=${DEBUG_PORT}"
  fi
  exit 0
fi

exit $?

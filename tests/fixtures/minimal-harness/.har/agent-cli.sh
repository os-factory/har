#!/usr/bin/env bash
set -euo pipefail
AGENT_ID="${1:?agent id required}"
CMD="${2:?command required}"
case "$CMD" in
  status)
    echo "Agent ${AGENT_ID} running"
    ;;
  logs)
    echo "log line for agent ${AGENT_ID}"
    ;;
  *)
    echo "unknown command: $CMD" >&2
    exit 1
    ;;
esac

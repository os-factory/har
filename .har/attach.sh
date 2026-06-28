#!/usr/bin/env bash
# Attach to the tmux session for an agent.
#
# Usage: ./.har/attach.sh <agent-id>
set -euo pipefail

AGENT_ID="${1:?Usage: attach.sh <agent-id>}"
SESSION="agent-${AGENT_ID}"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "No tmux session found: $SESSION" >&2
  echo "Launch with: ./.har/launch.sh ${AGENT_ID} --claude" >&2
  exit 1
fi

exec tmux attach -t "$SESSION"

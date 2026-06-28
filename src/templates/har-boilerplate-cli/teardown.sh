#!/usr/bin/env bash
# Tear down an agent slot for CLI/library repos.
#
# Usage: ./.har/teardown.sh <agent-id>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: teardown.sh <agent-id>}"

validate_agent_id "$AGENT_ID"

echo "==> Tearing down agent ${AGENT_ID}..."

rm -f "$REPO_ROOT/.env.agent.${AGENT_ID}"

WORKTREE_PATH="$HOME/worktrees/${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}"
if [ -d "$WORKTREE_PATH" ]; then
  git -C "$REPO_ROOT" worktree remove "$WORKTREE_PATH" --force 2>/dev/null || rm -rf "$WORKTREE_PATH"
  echo "✓ Removed worktree: $WORKTREE_PATH"
fi

echo "✓ Agent ${AGENT_ID} torn down"

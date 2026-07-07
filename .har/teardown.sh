#!/usr/bin/env bash
# Tear down an agent slot for CLI/library repos.
# The session's git branch is KEPT by default so you can push it / open a PR —
# pass --delete-branch to remove it too.
#
# Usage: ./.har/teardown.sh <agent-id> [--delete-branch]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: teardown.sh <agent-id> [--delete-branch]}"
DELETE_BRANCH=false

for arg in "${@:2}"; do
  case "$arg" in
    --delete-branch) DELETE_BRANCH=true ;;
  esac
done

validate_agent_id "$AGENT_ID"

echo "==> Tearing down agent ${AGENT_ID}..."

# Resolve the session from the registry; fall back to the legacy fixed path so
# pre-registry sessions stay removable.
REGISTRY_FILE="$(slot_registry_file "$AGENT_ID")"
WORKTREE_PATH=""
WORK_DIR=""
BRANCH=""
if [ -f "$REGISTRY_FILE" ]; then
  WORKTREE_PATH="$(read_slot_field "$REGISTRY_FILE" worktreePath || true)"
  WORK_DIR="$(read_slot_field "$REGISTRY_FILE" workDir || true)"
  BRANCH="$(read_slot_field "$REGISTRY_FILE" branch || true)"
fi
[ -n "$WORKTREE_PATH" ] || WORKTREE_PATH="$HOME/worktrees/${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}"

rm -f "$REPO_ROOT/.env.agent.${AGENT_ID}"
if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
  rm -f "$WORK_DIR/.env.agent.${AGENT_ID}"
fi

if [ -d "$WORKTREE_PATH" ]; then
  rm -f "$WORKTREE_PATH/.env.agent.${AGENT_ID}"
  git -C "$REPO_ROOT" worktree remove "$WORKTREE_PATH" --force 2>/dev/null || rm -rf "$WORKTREE_PATH"
  echo "✓ Removed worktree: $WORKTREE_PATH"
fi
git -C "$REPO_ROOT" worktree prune 2>/dev/null || true

if [ -n "$BRANCH" ]; then
  if [ "$DELETE_BRANCH" = true ]; then
    git -C "$REPO_ROOT" branch -D "$BRANCH" 2>/dev/null || true
    echo "✓ Deleted branch: $BRANCH"
  else
    echo "✓ Kept branch: $BRANCH (push it or delete with: git branch -D $BRANCH)"
  fi
fi

remove_slot_registry "$AGENT_ID"

echo "✓ Agent ${AGENT_ID} torn down"

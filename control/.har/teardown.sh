#!/usr/bin/env bash
# Safely tears down one agent: stops PM2, drops DB, removes bucket, cleans up files.
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

DB_PORT="${AGENT_DB_PORT:-15432}"

echo "==> Tearing down agent ${AGENT_ID}..."

npx --yes pm2 delete "/^agent-${AGENT_ID}-/" 2>/dev/null || true
echo "✓ Stopped PM2 processes"

if [ "$HARNESS_INFRA_POSTGRES" = "true" ]; then
  PGPASSWORD=password psql -h localhost -p "$DB_PORT" -U postgres postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='agent_${AGENT_ID}';" \
    >/dev/null 2>&1 || true
  PGPASSWORD=password dropdb -h localhost -p "$DB_PORT" -U postgres \
    --if-exists "agent_${AGENT_ID}" 2>/dev/null || true
  echo "✓ Dropped database: agent_${AGENT_ID}"
fi

if [ "$HARNESS_INFRA_MINIO" = "true" ]; then
  curl -sf -X DELETE "http://minioadmin:minioadmin@localhost:19000/agent-${AGENT_ID}?force=true" \
    >/dev/null 2>&1 || true
  echo "✓ Removed MinIO bucket: agent-${AGENT_ID}"
fi

rm -f "$REPO_ROOT/.env.agent.${AGENT_ID}"
rm -f "$REPO_ROOT/ecosystem.agent.${AGENT_ID}.config.cjs"

WORKTREE_PATH="$HOME/worktrees/${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}"
if [ -d "$WORKTREE_PATH" ]; then
  rm -f "$WORKTREE_PATH/.env.agent.${AGENT_ID}"
  rm -f "$WORKTREE_PATH/ecosystem.agent.${AGENT_ID}.config.cjs"
  git -C "$REPO_ROOT" worktree remove "$WORKTREE_PATH" --force 2>/dev/null || rm -rf "$WORKTREE_PATH"
  echo "✓ Removed worktree: $WORKTREE_PATH"
fi

echo "✓ Agent ${AGENT_ID} torn down"

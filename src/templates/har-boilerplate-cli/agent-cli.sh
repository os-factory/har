#!/usr/bin/env bash
# Namespaced CLI for managing a CLI/library agent slot.
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
DB_PORT="${AGENT_DB_PORT:-15432}"
export PGPASSWORD="password"

resolve_work_dir() {
  local env_file
  env_file="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT")" || {
    echo "No active environment for agent ${AGENT_ID}" >&2
    echo "  Run: ./.har/launch.sh ${AGENT_ID}" >&2
    exit 1
  }
  # shellcheck source=/dev/null
  source "$env_file"
  resolve_agent_work_dir "$env_file" "$AGENT_ID"
}

case "$COMMAND" in
  status)
    ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT" || true)"
    REGISTRY_FILE="$(slot_registry_file "$AGENT_ID")"

    if [ -n "$ENV_FILE" ]; then
      # shellcheck source=/dev/null
      source "$ENV_FILE"
      WT="$(existing_slot_worktree "$AGENT_ID")"
      echo "Agent ${AGENT_ID}: active"
      echo "  Work dir:  $(resolve_agent_work_dir "$ENV_FILE" "$AGENT_ID")"
      [ -n "$WT" ] && [ -d "$WT" ] && echo "  Worktree:  $WT"
      BRANCH="$(read_slot_field "$REGISTRY_FILE" branch || true)"
      PURPOSE="$(read_slot_field "$REGISTRY_FILE" purpose || true)"
      CREATED="$(read_slot_field "$REGISTRY_FILE" createdAt || true)"
      [ -n "$PURPOSE" ] && echo "  Purpose:   $PURPOSE"
      [ -n "$BRANCH" ] && echo "  Branch:    $BRANCH"
      [ -n "$CREATED" ] && echo "  Since:     $CREATED"
      [ -n "$WT" ] && echo "  Git:       $(slot_dirty_summary "$WT")"
    else
      echo "No active environment for agent ${AGENT_ID}"
      echo "  Run: ./.har/launch.sh ${AGENT_ID}"
    fi
    ;;

  logs)
    echo "CLI profile has no managed processes (no PM2)." >&2
    echo "Run project commands in the work dir, e.g.:" >&2
    echo "  ./.har/agent-cli.sh ${AGENT_ID} exec make test" >&2
    exit 1
    ;;

  restart)
    echo "CLI profile has no managed processes to restart." >&2
    echo "Re-run launch or use exec for project-specific commands." >&2
    exit 1
    ;;

  psql)
    QUERY="${3:-}"
    if ! har_infra_enabled db; then
      echo "PostgreSQL infra is disabled in harness.env" >&2
      exit 1
    fi
    if [ -n "$QUERY" ]; then
      har_pg psql -d "agent_${AGENT_ID}" -c "$QUERY"
    else
      har_pg psql -d "agent_${AGENT_ID}"
    fi
    ;;

  health)
    API_PORT=$(( HARNESS_API_BASE_PORT + AGENT_ID * 10 ))
    if [ -n "${HARNESS_HEALTH_CHECK_PATH:-}" ]; then
      curl -sf "http://localhost:${API_PORT}${HARNESS_HEALTH_CHECK_PATH}" | node -e "
const d = require('fs').readFileSync('/dev/stdin','utf8');
try { console.log(JSON.stringify(JSON.parse(d), null, 2)); } catch { console.log(d); }
" || curl -v "http://localhost:${API_PORT}${HARNESS_HEALTH_CHECK_PATH}"
    else
      echo "No health check path configured in harness.env"
    fi
    ;;

  url)
    FE_PORT=$(( HARNESS_FE_BASE_PORT + AGENT_ID * 10 ))
    API_PORT=$(( HARNESS_API_BASE_PORT + AGENT_ID * 10 ))
    WORK_DIR="$(resolve_work_dir 2>/dev/null || echo "$REPO_ROOT")"
    echo "Work dir:  $WORK_DIR"
    [ -d "$WORKTREE_DIR" ] && echo "Worktree:  $WORKTREE_DIR"
    [ -n "${HARNESS_HEALTH_CHECK_PATH:-}" ] && echo "API:       http://localhost:${API_PORT}${HARNESS_HEALTH_CHECK_PATH}"
    har_infra_enabled db && echo "Database:  agent_${AGENT_ID} @ localhost:${DB_PORT}"
    har_infra_enabled minio && echo "MinIO:     http://localhost:19001"
    har_infra_enabled headless-browser && echo "Browser:   http://localhost:13001"
    har_infra_enabled mailpit && echo "Mailpit:   http://localhost:18025"
    ;;

  reset-db)
    if ! har_infra_enabled db; then
      echo "PostgreSQL infra is disabled in harness.env" >&2
      exit 1
    fi
    echo "==> Resetting database for agent ${AGENT_ID}..."
    har_pg psql -d postgres -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='agent_${AGENT_ID}';" \
      >/dev/null
    har_pg dropdb --if-exists "agent_${AGENT_ID}"
    har_pg createdb -T "$HARNESS_TEMPLATE_DB" "agent_${AGENT_ID}"
    echo "✓ Database reset to clean state"
    ;;

  slow-queries)
    if ! har_infra_enabled db; then
      echo "PostgreSQL infra is disabled in harness.env" >&2
      exit 1
    fi
    har_pg psql -d "agent_${AGENT_ID}" -c "
SELECT round(mean_exec_time::numeric, 2) AS mean_ms,
       calls,
       left(query, 120) AS query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;" 2>/dev/null || echo "pg_stat_statements extension not available"
    ;;

  exec)
    shift 2
    if [ $# -eq 0 ]; then
      echo "Usage: agent-cli.sh ${AGENT_ID} exec <command>" >&2
      exit 1
    fi
    WORK_DIR="$(resolve_work_dir)"
    if har_infra_enabled db; then
      PGHOST=localhost PGPORT="$DB_PORT" PGUSER=postgres PGDATABASE="agent_${AGENT_ID}" \
        bash -c "cd '$WORK_DIR' && $*"
    else
      bash -c "cd '$WORK_DIR' && $*"
    fi
    ;;

  *)
    echo "Unknown command: $COMMAND" >&2
    echo ""
    echo "Commands: status, url, exec <cmd>"
    har_infra_enabled db && echo "          psql [query], reset-db, slow-queries"
    exit 1
    ;;
esac

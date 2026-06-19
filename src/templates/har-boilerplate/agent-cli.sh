#!/usr/bin/env bash
# Namespaced CLI for managing a running agent environment.
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

FE_PORT=$(( HARNESS_FE_BASE_PORT + AGENT_ID * 10 ))
API_PORT=$(( HARNESS_API_BASE_PORT + AGENT_ID * 10 ))
DB_PORT="${AGENT_DB_PORT:-15432}"
PG_OPTS="-h localhost -p $DB_PORT -U postgres"
export PGPASSWORD="password"

case "$COMMAND" in
  status)
    npx --yes pm2 jlist 2>/dev/null | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const procs = d.filter(x => x.name.startsWith('agent-${AGENT_ID}-'));
if (procs.length === 0) {
  console.log('No processes running for agent ${AGENT_ID}');
  process.exit(0);
}
console.log('Agent ${AGENT_ID} processes:');
procs.forEach(p => {
  const s = p.pm2_env.status.padEnd(10);
  const mem = Math.round((p.monit?.memory || 0) / 1024 / 1024) + 'MB';
  const cpu = (p.monit?.cpu || 0) + '%';
  console.log('  ' + p.name.padEnd(42) + s + '  mem=' + mem + '  cpu=' + cpu);
});
"
    ;;

  logs)
    SERVICE="${3:-}"
    if [ -n "$SERVICE" ]; then
      npx pm2 logs "agent-${AGENT_ID}-${SERVICE}" --lines 100
    else
      npx pm2 logs --name "agent-${AGENT_ID}" --lines 100
    fi
    ;;

  restart)
    SERVICE="${3:-}"
    if [ -n "$SERVICE" ]; then
      npx pm2 restart "agent-${AGENT_ID}-${SERVICE}"
    else
      npx pm2 jlist 2>/dev/null | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const names = d.filter(x => x.name.startsWith('agent-${AGENT_ID}-')).map(x => x.name);
names.forEach(n => require('child_process').execSync('npx pm2 restart ' + n, {stdio:'inherit'}));
if (names.length === 0) console.log('No processes found for agent ${AGENT_ID}');
" 2>/dev/null || true
    fi
    ;;

  psql)
    QUERY="${3:-}"
    if [ -n "$QUERY" ]; then
      psql $PG_OPTS -d "agent_${AGENT_ID}" -c "$QUERY"
    else
      psql $PG_OPTS -d "agent_${AGENT_ID}"
    fi
    ;;

  health)
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
    echo "Frontend:  http://localhost:${FE_PORT}"
    echo "API:       http://localhost:${API_PORT}"
    [ "$HARNESS_INFRA_POSTGRES" = "true" ] && echo "Database:  agent_${AGENT_ID} @ localhost:${DB_PORT}"
    [ "$HARNESS_INFRA_MINIO" = "true" ]   && echo "MinIO:     http://localhost:19001"
    [ "$HARNESS_INFRA_BROWSER" = "true" ] && echo "Browser:   http://localhost:13001"
    [ "$HARNESS_INFRA_MAILPIT" = "true" ] && echo "Mailpit:   http://localhost:18025"
    ;;

  reset-db)
    echo "==> Resetting database for agent ${AGENT_ID}..."
    psql $PG_OPTS postgres -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='agent_${AGENT_ID}';" \
      >/dev/null
    dropdb $PG_OPTS --if-exists "agent_${AGENT_ID}"
    createdb $PG_OPTS -T "$HARNESS_TEMPLATE_DB" "agent_${AGENT_ID}"
    echo "✓ Database reset to clean state"
    ;;

  slow-queries)
    psql $PG_OPTS -d "agent_${AGENT_ID}" -c "
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
    PGHOST=localhost PGPORT="$DB_PORT" PGUSER=postgres PGDATABASE="agent_${AGENT_ID}" \
      bash -c "cd '$REPO_ROOT' && $*"
    ;;

  attach)
    SESSION="agent-${AGENT_ID}"
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "No tmux session found: $SESSION" >&2
      exit 1
    fi
    tmux attach -t "$SESSION"
    ;;

  *)
    echo "Unknown command: $COMMAND" >&2
    echo ""
    echo "Commands: status, logs [service], restart [service], psql [query],"
    echo "          health, url, reset-db, slow-queries, exec <cmd>, attach"
    exit 1
    ;;
esac

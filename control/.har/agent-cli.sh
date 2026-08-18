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

load_agent_ports "$AGENT_ID" "$REPO_ROOT"

# Resolve this slot's SQLite database file (embedded — no DB server).
SLOT_WORK_DIR="$(resolve_agent_work_dir "" "$AGENT_ID" 2>/dev/null || true)"
[ -n "$SLOT_WORK_DIR" ] && [ -d "$SLOT_WORK_DIR" ] || SLOT_WORK_DIR="$REPO_ROOT"
SLOT_DB_FILE="$(har_slot_db_file "$SLOT_WORK_DIR" "$AGENT_ID")"

PM2_SLOT_PREFIX="$(har_pm2_slot_prefix "$AGENT_ID")"

case "$COMMAND" in
  status)
    ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT" || true)"
    WORKTREE_DIR="$(existing_slot_worktree "$AGENT_ID")"
    REG_FILE="$(slot_registry_file "$AGENT_ID")"
    PM2_RAW=$($(har_pkg_exec) pm2 jlist 2>/dev/null || true)
    PM2_FOUND=false
    PM2_FOREIGN=false
    PM2_LEGACY=false

    if [ -n "$PM2_RAW" ]; then
      set +e
      echo "$PM2_RAW" | node -e "
const agentId = '${AGENT_ID}';
const project = '${HARNESS_PROJECT_NAME}';
const slotPrefix = 'har-' + project + '-agent-' + agentId + '-';
const legacyPrefix = 'agent-' + agentId + '-';
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) process.exit(1);
    const owned = arr.filter(x => x.name && x.name.startsWith(slotPrefix));
    const foreignProject = arr.filter(x =>
      x.name && x.name.startsWith('har-') && x.name.includes('-agent-' + agentId + '-') && !x.name.startsWith(slotPrefix));
    const legacy = arr.filter(x => x.name && x.name.startsWith(legacyPrefix) && !x.name.startsWith('har-'));
    if (owned.length > 0) {
      console.log('Agent ' + agentId + ' processes (' + project + '):');
      owned.forEach(p => {
        const s = (p.pm2_env?.status || 'unknown').padEnd(10);
        const mem = Math.round((p.monit?.memory || 0) / 1024 / 1024) + 'MB';
        const cpu = (p.monit?.cpu || 0) + '%';
        const cwd = p.pm2_env?.pm_cwd || p.pm2_env?.cwd || '';
        console.log('  ' + p.name.padEnd(48) + s + '  mem=' + mem + '  cpu=' + cpu);
        if (cwd) console.log('    cwd: ' + cwd);
      });
      process.exit(0);
    }
    if (foreignProject.length > 0 || legacy.length > 0) {
      if (foreignProject.length > 0) {
        console.log('ERROR: foreign PM2 processes match agent ' + agentId + ' but belong to another harness:');
        foreignProject.forEach(p => console.log('  ' + p.name + '  cwd=' + (p.pm2_env?.pm_cwd || p.pm2_env?.cwd || 'unknown')));
      }
      if (legacy.length > 0) {
        console.log('ERROR: legacy PM2 processes (pre project-scoping) match agent ' + agentId + ':');
        legacy.forEach(p => console.log('  ' + p.name + '  cwd=' + (p.pm2_env?.pm_cwd || p.pm2_env?.cwd || 'unknown')));
      }
      process.exit(2);
    }
    process.exit(1);
  } catch {
    process.exit(1);
  }
});
"
      pm2_status=$?
      set -e
      case "$pm2_status" in
        0) PM2_FOUND=true ;;
        2) PM2_FOREIGN=true ;;
      esac
    fi

    if [ "$PM2_FOREIGN" = true ]; then
      exit 1
    fi

    if [ "$PM2_FOUND" = true ]; then
      if [ ! -f "$REG_FILE" ]; then
        echo "ERROR: slot registry missing at $REG_FILE but PM2 processes exist for this project." >&2
        echo "  Another harness may have been torn down incorrectly, or this slot was started outside launch.sh." >&2
        exit 1
      fi
      REG_PROJECT="$(read_slot_field "$REG_FILE" projectName || true)"
      if [ -n "$REG_PROJECT" ] && [ "$REG_PROJECT" != "$HARNESS_PROJECT_NAME" ]; then
        echo "ERROR: slot registry projectName=${REG_PROJECT} does not match harness ${HARNESS_PROJECT_NAME}." >&2
        exit 1
      fi
      if [ -z "$ENV_FILE" ]; then
        echo "ERROR: .env.agent.${AGENT_ID} could not be resolved — teardown this slot, then relaunch." >&2
        exit 1
      fi
    elif [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
      echo "Agent ${AGENT_ID}: active (no PM2 processes)"
      # shellcheck source=/dev/null
      source "$ENV_FILE" 2>/dev/null || true
      echo "  Work dir:  $(resolve_agent_work_dir "$ENV_FILE" "$AGENT_ID")"
      [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ] && echo "  Worktree:  $WORKTREE_DIR"
      echo "  Frontend:  http://localhost:${FE_PORT}"
      echo "  API:       http://localhost:${API_PORT}"
    else
      echo "No active environment for agent ${AGENT_ID}"
      har_suggest_launch "$AGENT_ID"
    fi
    ;;

  logs)
    SERVICE="${3:-}"
    if [ -n "$SERVICE" ]; then
      $(har_pkg_exec) pm2 logs "${PM2_SLOT_PREFIX}-${SERVICE}" --lines 100
    else
      $(har_pkg_exec) pm2 logs --name "${PM2_SLOT_PREFIX}" --lines 100
    fi
    ;;

  restart)
    SERVICE="${3:-}"
    if [ -n "$SERVICE" ]; then
      $(har_pkg_exec) pm2 restart "${PM2_SLOT_PREFIX}-${SERVICE}"
    else
      $(har_pkg_exec) pm2 jlist 2>/dev/null | node -e "
const prefix = '${PM2_SLOT_PREFIX}-';
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const names = d.filter(x => x.name && x.name.startsWith(prefix)).map(x => x.name);
names.forEach(n => require('child_process').execSync('$(har_pkg_exec) pm2 restart ' + n, {stdio:'inherit'}));
if (names.length === 0) console.log('No processes found for ${PM2_SLOT_PREFIX}');
" 2>/dev/null || true
    fi
    ;;

  sqlite | psql)
    if ! command -v sqlite3 >/dev/null 2>&1; then
      echo "sqlite3 CLI not installed — inspect ${SLOT_DB_FILE} with any SQLite tool." >&2
      exit 1
    fi
    QUERY="${3:-}"
    if [ -n "$QUERY" ]; then
      sqlite3 "$SLOT_DB_FILE" "$QUERY"
    else
      sqlite3 "$SLOT_DB_FILE"
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
    echo "Database:  SQLite ${SLOT_DB_FILE}"
    har_infra_enabled minio            && echo "MinIO:     http://localhost:${AGENT_MINIO_CONSOLE_PORT:-19001}"
    har_infra_enabled headless-browser && echo "Browser:   http://localhost:${AGENT_BROWSER_PORT:-13001}"
    har_infra_enabled mailpit          && echo "Mailpit:   http://localhost:${AGENT_MAILPIT_WEB_PORT:-18025}"
    ;;

  reset-db)
    echo "==> Resetting SQLite database for agent ${AGENT_ID}..."
    rm -f "$SLOT_DB_FILE" "${SLOT_DB_FILE}-journal" "${SLOT_DB_FILE}-wal" "${SLOT_DB_FILE}-shm"
    (cd "$SLOT_WORK_DIR" && DATABASE_URL="$(har_slot_db_url "$AGENT_ID")" npx prisma db push --skip-generate)
    echo "✓ Database reset to clean state"
    ;;

  slow-queries)
    echo "slow-queries is a PostgreSQL-only helper (pg_stat_statements)." >&2
    echo "Mission Control now uses SQLite — inspect ${SLOT_DB_FILE} with: $0 ${AGENT_ID} sqlite" >&2
    ;;

  exec)
    shift 2
    if [ $# -eq 0 ]; then
      echo "Usage: agent-cli.sh ${AGENT_ID} exec <command>" >&2
      exit 1
    fi
    WORK_DIR="$(resolve_agent_work_dir "" "$AGENT_ID" 2>/dev/null || true)"
    [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] || WORK_DIR="$REPO_ROOT"
    DATABASE_URL="$(har_slot_db_url "$AGENT_ID")" \
      bash -c "cd '$WORK_DIR' && $*"
    ;;

  attach)
    SESSION="$(har_tmux_session "$AGENT_ID")"
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "No tmux session found: $SESSION" >&2
      exit 1
    fi
    tmux attach -t "$SESSION"
    ;;

  *)
    echo "Unknown command: $COMMAND" >&2
    echo ""
    echo "Commands: status, logs [service], restart [service], sqlite [query],"
    echo "          health, url, reset-db, exec <cmd>, attach"
    exit 1
    ;;
esac

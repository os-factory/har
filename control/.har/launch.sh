#!/usr/bin/env bash
# Launches a single agent instance with isolated ports, database, and PM2 processes.
# Idempotent — safe to run multiple times for the same agent.
#
# Usage: ./.har/launch.sh <agent-id> [--no-worktree] [--claude]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

AGENT_ID="${1:-}"
USE_WORKTREE="${HARNESS_USE_WORKTREE:-true}"
USE_CLAUDE=false

for arg in "$@"; do
  case "$arg" in
    --no-worktree) USE_WORKTREE=false ;;
    --worktree) USE_WORKTREE=true ;;
    --claude)   USE_CLAUDE=true ;;
  esac
done

if [[ -z "$AGENT_ID" ]]; then
  echo "Usage: $0 <agent-id> [--no-worktree] [--claude]" >&2
  echo "  agent-id must be between ${HARNESS_AGENT_SLOT_MIN} and ${HARNESS_AGENT_SLOT_MAX}" >&2
  exit 1
fi

validate_agent_id "$AGENT_ID"

log() { echo "==> [agent-$AGENT_ID] $*" >&2; }

FE_PORT=$(( HARNESS_FE_BASE_PORT + AGENT_ID * 10 ))
API_PORT=$(( HARNESS_API_BASE_PORT + AGENT_ID * 10 ))
DEBUG_PORT=$(( 9200 + AGENT_ID * 10 ))
DB_PORT="${AGENT_DB_PORT:-15432}"
MINIO_PORT="${AGENT_MINIO_PORT:-19000}"
BROWSER_PORT="${AGENT_BROWSER_PORT:-13001}"

log "Ports: frontend=$FE_PORT api=$API_PORT debug=$DEBUG_PORT"

# Ensure shared infra is running
"$SCRIPT_DIR/setup-infra.sh"

# Clone agent database from template
if [ "$HARNESS_INFRA_POSTGRES" = "true" ] && [ -n "${HARNESS_TEMPLATE_DB:-}" ]; then
  AGENT_DB="agent_${AGENT_ID}"
  PSQL="psql -h localhost -p $DB_PORT -U postgres -d postgres"
  if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname = '$AGENT_DB'" | grep -q 1; then
    log "Database '$AGENT_DB' already exists."
  else
    log "Creating database '$AGENT_DB' from template..."
    $PSQL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$HARNESS_TEMPLATE_DB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
    PGPASSWORD=password createdb -h localhost -p "$DB_PORT" -U postgres -T "$HARNESS_TEMPLATE_DB" "$AGENT_DB"
    log "Database '$AGENT_DB' created."
  fi
fi

# Create MinIO bucket
if [ "$HARNESS_INFRA_MINIO" = "true" ]; then
  MINIO_BUCKET="agent-${AGENT_ID}"
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    -u "minioadmin:minioadmin" \
    "http://localhost:${MINIO_PORT}/${MINIO_BUCKET}/" 2>/dev/null) || true
  log "MinIO bucket '$MINIO_BUCKET' ready (HTTP $HTTP_STATUS)."
fi

# Git worktree (default — use --no-worktree to work in repo root)
WORK_DIR="$REPO_ROOT"
WORKTREE_DIR="$HOME/worktrees/${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}"
if [ "$USE_WORKTREE" = true ]; then
  if [ -d "$WORKTREE_DIR" ]; then
    log "Worktree already exists at $WORKTREE_DIR"
  else
    log "Creating git worktree at $WORKTREE_DIR..."
    git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "har-agent-${AGENT_ID}" 2>/dev/null || \
      git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" HEAD
  fi
  # Worktrees are always rooted at the git repo — control/ lives in a
  # subdirectory of the monorepo, so point WORK_DIR at it inside the worktree.
  REL_PREFIX="$(git -C "$REPO_ROOT" rev-parse --show-prefix 2>/dev/null || true)"
  WORK_DIR="${WORKTREE_DIR%/}/${REL_PREFIX}"
  WORK_DIR="${WORK_DIR%/}"
else
  log "Using repo root (worktree disabled)"
fi

# Install dependencies (fresh worktrees have no node_modules — PM2 config needs them at load time)
if [ -f "$WORK_DIR/package.json" ] && [ ! -d "$WORK_DIR/node_modules" ]; then
  log "Installing dependencies in $WORK_DIR..."
  (cd "$WORK_DIR" && npm install --silent)
fi

# Monorepo: @har/schemas (file:../packages/schemas) resolves zod etc. from the repo root — install there too
if [ -n "${REL_PREFIX:-}" ] && [ -f "$WORKTREE_DIR/package.json" ] && [ ! -d "$WORKTREE_DIR/node_modules" ]; then
  log "Installing monorepo root dependencies in $WORKTREE_DIR..."
  (cd "$WORKTREE_DIR" && npm install --silent)
fi

# Generate .env.agent.N
ENV_FILE="$WORK_DIR/.env.agent.${AGENT_ID}"
log "Generating $ENV_FILE..."
AGENT_ID="$AGENT_ID" \
API_PORT="$API_PORT" \
FE_PORT="$FE_PORT" \
DEBUG_PORT="$DEBUG_PORT" \
DB_PORT="$DB_PORT" \
MINIO_PORT="$MINIO_PORT" \
BROWSER_PORT="$BROWSER_PORT" \
REPO_ROOT="$WORK_DIR" \
  envsubst '${AGENT_ID} ${API_PORT} ${FE_PORT} ${DEBUG_PORT} ${DB_PORT} ${MINIO_PORT} ${BROWSER_PORT} ${REPO_ROOT}' \
  < "$SCRIPT_DIR/env.template" > "$ENV_FILE"

# Generate PM2 ecosystem config
ECOSYSTEM_FILE="$WORK_DIR/ecosystem.agent.${AGENT_ID}.config.cjs"
log "Generating $ECOSYSTEM_FILE..."
AGENT_ID="$AGENT_ID" \
FE_PORT="$FE_PORT" \
DEBUG_PORT="$DEBUG_PORT" \
  envsubst '${AGENT_ID} ${FE_PORT} ${DEBUG_PORT}' \
  < "$SCRIPT_DIR/ecosystem.agent.template.cjs" > "$ECOSYSTEM_FILE"

# Apply database schema (idempotent) — otherwise schema drift after a code
# change surfaces as runtime 500s in the slot instead of a clear launch error.
if [ -n "${HARNESS_DB_MIGRATE_CMD:-}" ] && [ "$HARNESS_DB_MIGRATE_CMD" != "true" ]; then
  log "Applying database schema: $HARNESS_DB_MIGRATE_CMD"
  (cd "$WORK_DIR" && set -a && . "$ENV_FILE" && set +a && eval "$HARNESS_DB_MIGRATE_CMD" >&2) || {
    log "ERROR: database migrate command failed: $HARNESS_DB_MIGRATE_CMD"
    exit 1
  }
fi

# Stop existing processes for this agent
npx --yes pm2 delete "/^agent-${AGENT_ID}-/" 2>/dev/null || true
sleep 1

# Fail loudly if a foreign process holds this slot's ports — otherwise the
# health check below can pass against that server while ours crash-loops on
# EADDRINUSE, and the slot silently serves someone else's code.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- || true; return 0; }; return 1; }
for PORT in $(printf '%s\n' "$FE_PORT" "$API_PORT" | sort -u); do
  if port_in_use "$PORT"; then
    log "ERROR: port $PORT is already in use by a process outside this slot."
    log "Stop whatever is bound to it (another dev server, or a 'docker compose up' app container), then relaunch."
    exit 1
  fi
done

# Start PM2 processes
log "Starting PM2 processes..."
cd "$WORK_DIR"
npx pm2 start "$ECOSYSTEM_FILE"
npx pm2 save --force >/dev/null 2>&1 || true

# Health check
if [ -n "${HARNESS_HEALTH_CHECK_PATH:-}" ]; then
  HEALTH_URL="http://localhost:${API_PORT}${HARNESS_HEALTH_CHECK_PATH}"
  log "Waiting for health check at $HEALTH_URL..."
  TIMEOUT=60
  ELAPSED=0
  while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null) || true
    if [ "$HTTP_CODE" = "200" ]; then
      log "Health check passed!"
      break
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
  done
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    log "Warning: Health check did not pass within ${TIMEOUT}s."
    log "Check logs: ./.har/agent-cli.sh $AGENT_ID logs"
  fi
fi

# The health check only proves the port answers — confirm the processes we
# just started are the ones running (online, not crash-looping).
if ! npx --yes pm2 jlist 2>/dev/null | AGENT_PREFIX="agent-${AGENT_ID}-" node -e '
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => {
  const prefix = process.env.AGENT_PREFIX;
  const procs = JSON.parse(d || "[]").filter((p) => p.name && p.name.startsWith(prefix));
  if (procs.length === 0) {
    console.error("no PM2 processes matching " + prefix);
    process.exit(1);
  }
  const bad = procs.filter((p) => p.pm2_env.status !== "online" || p.pm2_env.restart_time >= 3);
  for (const p of bad) {
    console.error(p.name + ": " + p.pm2_env.status + " (restarts: " + p.pm2_env.restart_time + ")");
  }
  process.exit(bad.length ? 1 : 0);
});
'; then
  log "ERROR: PM2 processes for agent ${AGENT_ID} are not healthy — the slot is not serving this worktree."
  log "Check logs: ./.har/agent-cli.sh $AGENT_ID logs"
  exit 1
fi

# Launch Claude Code in tmux (optional)
if [ "$USE_CLAUDE" = true ]; then
  TMUX_SESSION="agent-${AGENT_ID}"
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    tmux kill-session -t "$TMUX_SESSION"
  fi
  tmux new-session -d -s "$TMUX_SESSION" -c "$WORK_DIR" "claude"
  log "Claude session: tmux attach -t $TMUX_SESSION"
fi

echo ""
log "Agent $AGENT_ID is ready!"
log "  Work dir:  ${WORK_DIR}"
[ "$USE_WORKTREE" = true ] && log "  Worktree:  ${WORKTREE_DIR}"
log "  Frontend:  http://localhost:${FE_PORT}"
log "  API:       http://localhost:${API_PORT}"
[ "$HARNESS_INFRA_POSTGRES" = "true" ] && log "  Database:  agent_${AGENT_ID} @ localhost:${DB_PORT}"
log ""
log "  Verify:    ./.har/verify.sh $AGENT_ID"
log "  CLI:       ./.har/agent-cli.sh $AGENT_ID <command>"
log "  Teardown:  ./.har/teardown.sh $AGENT_ID"

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
if har_infra_enabled db && [ -n "${HARNESS_TEMPLATE_DB:-}" ]; then
  AGENT_DB="agent_${AGENT_ID}"
  PSQL="har_pg psql -d postgres"
  if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname = '$AGENT_DB'" | grep -q 1; then
    log "Database '$AGENT_DB' already exists."
  else
    log "Creating database '$AGENT_DB' from template..."
    $PSQL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$HARNESS_TEMPLATE_DB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
    har_pg createdb -T "$HARNESS_TEMPLATE_DB" "$AGENT_DB"
    log "Database '$AGENT_DB' created."
  fi
fi

# Create MinIO bucket
if har_infra_enabled minio; then
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
  # Worktrees are always rooted at the git repo — if this project lives in a
  # subdirectory (monorepo), point WORK_DIR at the project inside the worktree.
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
elif [ -f "$WORK_DIR/go.mod" ] && [ ! -d "$WORK_DIR/vendor" ]; then
  log "Go module detected in work dir (run go mod download if needed)"
fi

# Monorepo: file:/workspace deps may resolve modules from the repo root — install there too
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

# Stop existing processes for this agent
npx --yes pm2 delete "/^agent-${AGENT_ID}-/" 2>/dev/null || true

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
har_infra_enabled db && log "  Database:  agent_${AGENT_ID} @ localhost:${DB_PORT}"
log ""
log "  Verify:    ./.har/verify.sh $AGENT_ID"
log "  CLI:       ./.har/agent-cli.sh $AGENT_ID <command>"
log "  Teardown:  ./.har/teardown.sh $AGENT_ID"

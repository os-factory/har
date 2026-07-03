#!/usr/bin/env bash
# Launches a single agent instance with isolated ports, database, and PM2 processes.
# Every launch starts a FRESH session: any previous session for the slot is torn
# down (its branch is kept) and a new suffixed worktree is created from HEAD.
#
# Usage: ./.har/launch.sh <agent-id> [--no-worktree] [--claude] [--force]
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
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --no-worktree) USE_WORKTREE=false ;;
    --worktree) USE_WORKTREE=true ;;
    --claude)   USE_CLAUDE=true ;;
    --force)    FORCE=true ;;
  esac
done

if [[ -z "$AGENT_ID" ]]; then
  echo "Usage: $0 <agent-id> [--no-worktree] [--claude] [--force]" >&2
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

# Replace any previous session for this slot — launch always means "run my
# current code", never "reuse whatever this slot ran last time".
REGISTRY_FILE="$(slot_registry_file "$AGENT_ID")"
EXISTING_WORKTREE="$(existing_slot_worktree "$AGENT_ID")"
if [ -f "$REGISTRY_FILE" ] || [ -n "$EXISTING_WORKTREE" ]; then
  if [ -n "$EXISTING_WORKTREE" ] && slot_worktree_dirty "$EXISTING_WORKTREE" && [ "$FORCE" != true ]; then
    log "ERROR: previous session for slot ${AGENT_ID} has uncommitted changes in:"
    log "  $EXISTING_WORKTREE"
    log "Commit them there (the branch is kept on teardown), or relaunch with --force to discard them."
    exit 1
  fi
  log "Replacing previous session for slot ${AGENT_ID}..."
  "$SCRIPT_DIR/teardown.sh" "$AGENT_ID" >&2
fi

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

# Session worktree (default — use --no-worktree to work in repo root).
# Name encodes what the session is based on: <base-branch>-<sha4>-har-agent-<id>-<rand4>.
WORK_DIR="$REPO_ROOT"
WORKTREE_DIR=""
BRANCH=""
SUFFIX=""
BASE_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")"
BASE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [ "$USE_WORKTREE" = true ]; then
  SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=4 HEAD)"
  SUFFIX="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 4 || true)"
  [ -n "$SUFFIX" ] || SUFFIX="$(printf '%04d' $(( RANDOM % 10000 )))"
  SESSION_NAME="${BASE_BRANCH//\//-}-${SHORT_SHA}-har-agent-${AGENT_ID}-${SUFFIX}"
  BRANCH="$SESSION_NAME"
  WORKTREE_DIR="$HOME/worktrees/${SESSION_NAME}"
  log "Creating session worktree at $WORKTREE_DIR (branch $BRANCH)..."
  git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH"
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

# Monorepo: install root deps for worktrees that include the full repo checkout
if [ -n "${REL_PREFIX:-}" ] && [ -f "$WORKTREE_DIR/package.json" ] && [ ! -d "$WORKTREE_DIR/node_modules" ]; then
  log "Installing monorepo root dependencies in $WORKTREE_DIR..."
  (cd "$WORKTREE_DIR" && npm install --silent)
fi

# @har/schemas is linked via file:../packages/schemas — tsc resolves zod from that package dir
if [ -d "$WORK_DIR/../packages/schemas" ]; then
  SCHEMAS_DIR="$(cd "$WORK_DIR/../packages/schemas" && pwd)"
  if [ -f "$SCHEMAS_DIR/package.json" ] && [ ! -d "$SCHEMAS_DIR/node_modules" ]; then
    log "Installing @har/schemas dependencies in $SCHEMAS_DIR..."
    (cd "$SCHEMAS_DIR" && npm install --silent)
  fi
fi

# Generate .env.agent.N
# Keep harness-generated files out of accidental `git add -A` commits in repos
# whose .gitignore doesn't know about har (applies to all worktrees too).
GIT_EXCLUDE="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)/info/exclude"
if [ -n "$GIT_EXCLUDE" ] && [ -d "$(dirname "$GIT_EXCLUDE")" ]; then
  for pattern in '.env.agent.*' 'ecosystem.agent.*.config.cjs'; do
    grep -qxF "$pattern" "$GIT_EXCLUDE" 2>/dev/null || echo "$pattern" >> "$GIT_EXCLUDE"
  done
fi

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

# Record the session in the slot registry — the source of truth for where
# this slot's code lives (status/verify/teardown resolve through it).
SLOT_AGENT_ID="$AGENT_ID" \
SLOT_MODE="$([ "$USE_WORKTREE" = true ] && echo worktree || echo root)" \
SLOT_WORK_DIR="$WORK_DIR" \
SLOT_SUFFIX="${SUFFIX:-}" \
SLOT_WORKTREE_PATH="${WORKTREE_DIR:-}" \
SLOT_BRANCH="${BRANCH:-}" \
SLOT_BASE_BRANCH="${BASE_BRANCH:-}" \
SLOT_BASE_COMMIT="${BASE_COMMIT:-}" \
SLOT_PORTS_JSON="{\"frontend\":${FE_PORT},\"api\":${API_PORT},\"debug\":${DEBUG_PORT}}" \
SLOT_PREVIEW_URLS_JSON="{\"frontend\":\"http://localhost:${FE_PORT}\",\"api\":\"http://localhost:${API_PORT}\"}" \
  write_slot_registry

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
log ""
log "  WORK DIR (make ALL file edits under this path — never the main checkout):"
log "    ${WORK_DIR}"
if [ "$USE_WORKTREE" = true ]; then
  log "  Branch:    ${BRANCH} (based on ${BASE_BRANCH} @ ${BASE_COMMIT})"
fi
log "  Frontend:  http://localhost:${FE_PORT}"
log "  API:       http://localhost:${API_PORT}"
har_infra_enabled db && log "  Database:  agent_${AGENT_ID} @ localhost:${DB_PORT}"
log ""
log "  Edits under the work dir hot-reload in the running slot;"
log "  use ./.har/agent-cli.sh $AGENT_ID restart if a change doesn't take."
log "  Verify:    ./.har/verify.sh $AGENT_ID"
log "  Teardown:  ./.har/teardown.sh $AGENT_ID   (keeps the branch)"

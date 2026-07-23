#!/usr/bin/env bash
# Launches a single agent instance with isolated ports, database, and PM2 processes.
# Every launch starts a FRESH session: any previous session for the slot is torn
# down (its branch is kept) and a new suffixed worktree is created from HEAD.
#
# Usage: ./.har/launch.sh <agent-id> [--no-worktree] [--claude] [--replace] [--force] [--resume] [--purpose=label]
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
REPLACE=false
RESUME=false
PURPOSE="${HAR_SESSION_PURPOSE:-}"

for arg in "$@"; do
  case "$arg" in
    --no-worktree) USE_WORKTREE=false ;;
    --worktree) USE_WORKTREE=true ;;
    --claude)   USE_CLAUDE=true ;;
    --replace)  REPLACE=true ;;
    --force)    FORCE=true ;;
    --resume)   RESUME=true ;;
    --purpose=*) PURPOSE="${arg#--purpose=}" ;;
  esac
done

if [[ -z "$AGENT_ID" ]]; then
  har_load_agent_slot_limits
  echo "Usage: $0 <agent-id> [--no-worktree] [--claude] [--replace] [--force] [--resume] [--purpose=label]" >&2
  echo "  agent-id must be between ${HARNESS_AGENT_SLOT_MIN} and ${HARNESS_AGENT_SLOT_MAX}" >&2
  exit 1
fi

validate_agent_id "$AGENT_ID"

log() { echo "==> [agent-$AGENT_ID] $*" >&2; }

WORK_DIR="$REPO_ROOT"
WORKTREE_DIR=""
BRANCH=""
SUFFIX=""
BASE_BRANCH=""
BASE_COMMIT=""
ENV_FILE=""
REGISTRY_WRITTEN=false

if [ "$RESUME" = true ]; then
  har_launch_preflight "$AGENT_ID" "$FORCE" "$REPLACE" true || exit $?
  eval "$(har_resume_session_assignments "$AGENT_ID")"
  REGISTRY_WRITTEN=true
  mark_slot_failed() {
    local exit_code="$?"
    if [ "$exit_code" != "0" ] && [ "$REGISTRY_WRITTEN" = true ]; then
      log "Resume failed. Recording failed slot state..."
      set +e
      SLOT_AGENT_ID="$AGENT_ID" \
      SLOT_MODE="$([ "$USE_WORKTREE" = true ] && echo worktree || echo root)" \
      SLOT_WORK_DIR="$WORK_DIR" \
      SLOT_SUFFIX="${SUFFIX:-}" \
      SLOT_WORKTREE_PATH="${WORKTREE_DIR:-}" \
      SLOT_BRANCH="${BRANCH:-}" \
      SLOT_BASE_BRANCH="${BASE_BRANCH:-}" \
      SLOT_BASE_COMMIT="${BASE_COMMIT:-}" \
      SLOT_PORTS_JSON="{\"frontend\":${FE_PORT},\"api\":${API_PORT},\"debug\":${DEBUG_PORT},\"db\":${DB_PORT}}" \
      SLOT_PREVIEW_URLS_JSON="{\"frontend\":\"http://localhost:${FE_PORT}\",\"api\":\"http://localhost:${API_PORT}\"}" \
      SLOT_PURPOSE="${PURPOSE}" \
      SLOT_STATUS="failed" \
      SLOT_LAST_ERROR="launch.sh --resume exited with code ${exit_code}" \
        write_slot_registry
      log "  Work dir:  ${WORK_DIR}"
      log "  Env file:  ${ENV_FILE}"
      log "  Recovery:  har env launch ${AGENT_ID} --resume  # or ./.har/launch.sh ${AGENT_ID} --resume"
    fi
  }
  trap mark_slot_failed EXIT
else
  # Preflight before worktree/install — ports, foreign PM2, Docker, occupied slot.
  har_launch_preflight "$AGENT_ID" "$FORCE" "$REPLACE" || exit $?

  # Replace any previous session for this slot — requires explicit confirmation.
  if slot_is_occupied "$AGENT_ID"; then
    require_slot_replace_confirm "$AGENT_ID" "$FORCE" "$REPLACE"
    log "Replacing previous session for slot ${AGENT_ID}..."
    "$SCRIPT_DIR/teardown.sh" "$AGENT_ID" >&2
  fi
fi

if har_harness_uses_pm2; then
  log "Ports: frontend=$FE_PORT api=$API_PORT debug=$DEBUG_PORT"
fi

# Ensure shared infra is running (persists host ports in .har/state/infra.env).
"$SCRIPT_DIR/setup-infra.sh"
DB_PORT="${AGENT_DB_PORT:-${HARNESS_DB_PORT_DEFAULT:-15432}}"
MINIO_PORT="${AGENT_MINIO_PORT:-${HARNESS_MINIO_PORT_DEFAULT:-19000}}"
BROWSER_PORT="${AGENT_BROWSER_PORT:-${HARNESS_BROWSER_PORT_DEFAULT:-13001}}"

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
if [ "$RESUME" != true ]; then
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
    REL_PREFIX="$(git -C "$REPO_ROOT" rev-parse --show-prefix 2>/dev/null || true)"
    WORK_DIR="${WORKTREE_DIR%/}/${REL_PREFIX}"
    WORK_DIR="${WORK_DIR%/}"
  else
    log "Using repo root (worktree disabled)"
    REL_PREFIX="$(git -C "$REPO_ROOT" rev-parse --show-prefix 2>/dev/null || true)"
  fi

  GIT_EXCLUDE="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)/info/exclude"
  if [ -n "$GIT_EXCLUDE" ] && [ -d "$(dirname "$GIT_EXCLUDE")" ]; then
    for pattern in '.env.agent.*' 'ecosystem.agent.*.config.cjs' '.har/venv'; do
      grep -qxF "$pattern" "$GIT_EXCLUDE" 2>/dev/null || echo "$pattern" >> "$GIT_EXCLUDE"
    done
  fi

  ENV_FILE="$WORK_DIR/.env.agent.${AGENT_ID}"
  log "Generating $ENV_FILE..."
  har_regenerate_agent_env_file "$AGENT_ID" "$WORK_DIR" "$ENV_FILE"

  REGISTRY_WRITTEN=false
  mark_slot_failed() {
    local exit_code="$?"
    if [ "$exit_code" != "0" ] && [ "$REGISTRY_WRITTEN" = true ]; then
      log "Launch failed after creating the session. Recording failed slot state..."
      set +e
      SLOT_AGENT_ID="$AGENT_ID" \
      SLOT_MODE="$([ "$USE_WORKTREE" = true ] && echo worktree || echo root)" \
      SLOT_WORK_DIR="$WORK_DIR" \
      SLOT_SUFFIX="${SUFFIX:-}" \
      SLOT_WORKTREE_PATH="${WORKTREE_DIR:-}" \
      SLOT_BRANCH="${BRANCH:-}" \
      SLOT_BASE_BRANCH="${BASE_BRANCH:-}" \
      SLOT_BASE_COMMIT="${BASE_COMMIT:-}" \
      SLOT_PORTS_JSON="{\"frontend\":${FE_PORT},\"api\":${API_PORT},\"debug\":${DEBUG_PORT},\"db\":${DB_PORT}}" \
      SLOT_PREVIEW_URLS_JSON="{\"frontend\":\"http://localhost:${FE_PORT}\",\"api\":\"http://localhost:${API_PORT}\"}" \
      SLOT_PURPOSE="${PURPOSE}" \
      SLOT_STATUS="failed" \
      SLOT_LAST_ERROR="launch.sh exited with code ${exit_code}" \
        write_slot_registry
      log "  Work dir:  ${WORK_DIR}"
      log "  Env file:  ${ENV_FILE}"
      log "  Recovery:  har env launch ${AGENT_ID} --resume  # or ./.har/launch.sh ${AGENT_ID} --resume"
    fi
  }
  trap mark_slot_failed EXIT

  SLOT_AGENT_ID="$AGENT_ID" \
  SLOT_MODE="$([ "$USE_WORKTREE" = true ] && echo worktree || echo root)" \
  SLOT_WORK_DIR="$WORK_DIR" \
  SLOT_SUFFIX="${SUFFIX:-}" \
  SLOT_WORKTREE_PATH="${WORKTREE_DIR:-}" \
  SLOT_BRANCH="${BRANCH:-}" \
  SLOT_BASE_BRANCH="${BASE_BRANCH:-}" \
  SLOT_BASE_COMMIT="${BASE_COMMIT:-}" \
  SLOT_PORTS_JSON="{\"frontend\":${FE_PORT},\"api\":${API_PORT},\"debug\":${DEBUG_PORT},\"db\":${DB_PORT}}" \
  SLOT_PREVIEW_URLS_JSON="{\"frontend\":\"http://localhost:${FE_PORT}\",\"api\":\"http://localhost:${API_PORT}\"}" \
  SLOT_PURPOSE="${PURPOSE}" \
  SLOT_STATUS="starting" \
    write_slot_registry
  REGISTRY_WRITTEN=true
else
  REL_PREFIX="$(git -C "$REPO_ROOT" rev-parse --show-prefix 2>/dev/null || true)"
  log "Resuming session at ${WORK_DIR}"
  har_regenerate_agent_env_file "$AGENT_ID" "$WORK_DIR" "$ENV_FILE"
  SLOT_AGENT_ID="$AGENT_ID" \
  SLOT_MODE="$([ "$USE_WORKTREE" = true ] && echo worktree || echo root)" \
  SLOT_WORK_DIR="$WORK_DIR" \
  SLOT_SUFFIX="${SUFFIX:-}" \
  SLOT_WORKTREE_PATH="${WORKTREE_DIR:-}" \
  SLOT_BRANCH="${BRANCH:-}" \
  SLOT_BASE_BRANCH="${BASE_BRANCH:-}" \
  SLOT_BASE_COMMIT="${BASE_COMMIT:-}" \
  SLOT_PORTS_JSON="{\"frontend\":${FE_PORT},\"api\":${API_PORT},\"debug\":${DEBUG_PORT},\"db\":${DB_PORT}}" \
  SLOT_PREVIEW_URLS_JSON="{\"frontend\":\"http://localhost:${FE_PORT}\",\"api\":\"http://localhost:${API_PORT}\"}" \
  SLOT_PURPOSE="${PURPOSE}" \
  SLOT_STATUS="starting" \
    write_slot_registry
fi

if [ "$RESUME" = true ] && har_toolchain_ready "$WORK_DIR"; then
  log "Toolchain already provisioned — skipping install."
else
  log "Provisioning toolchain (see harness.env: HARNESS_ECOSYSTEM, HARNESS_INSTALL_CMD)..."
  HAR_WORK_DIR="$WORK_DIR" \
  HAR_ENV_FILE="$ENV_FILE" \
  HAR_WORKTREE_DIR="${WORKTREE_DIR:-}" \
  HAR_REL_PREFIX="${REL_PREFIX:-}" \
  HAR_AGENT_ID="$AGENT_ID" \
    "$SCRIPT_DIR/provision-toolchain.sh"
fi

if [ -n "${HARNESS_DB_MINIMAL_BOOTSTRAP_CMD:-}" ]; then
  log "Running minimal data bootstrap..."
  (cd "$WORK_DIR" && set -a && . "$ENV_FILE" && set +a && eval "$HARNESS_DB_MINIMAL_BOOTSTRAP_CMD")
fi

# Generate PM2 ecosystem config
ECOSYSTEM_FILE="$WORK_DIR/ecosystem.agent.${AGENT_ID}.config.cjs"
log "Generating $ECOSYSTEM_FILE..."
AGENT_ID="$AGENT_ID" \
HARNESS_PROJECT_NAME="$HARNESS_PROJECT_NAME" \
FE_PORT="$FE_PORT" \
DEBUG_PORT="$DEBUG_PORT" \
  envsubst '${AGENT_ID} ${HARNESS_PROJECT_NAME} ${FE_PORT} ${DEBUG_PORT}' \
  < "$SCRIPT_DIR/ecosystem.agent.template.cjs" > "$ECOSYSTEM_FILE"

PM2_REGEX="$(har_pm2_delete_regex "$AGENT_ID")"
# Stop existing processes for this agent (project-scoped — never touch other harnesses).
npx --yes pm2 delete "$PM2_REGEX" 2>/dev/null || true

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
SLOT_PORTS_JSON="{\"frontend\":${FE_PORT},\"api\":${API_PORT},\"debug\":${DEBUG_PORT},\"db\":${DB_PORT}}" \
SLOT_PREVIEW_URLS_JSON="{\"frontend\":\"http://localhost:${FE_PORT}\",\"api\":\"http://localhost:${API_PORT}\"}" \
SLOT_PURPOSE="${PURPOSE}" \
SLOT_STATUS="active" \
  write_slot_registry

# Launch Claude Code in tmux (optional)
if [ "$USE_CLAUDE" = true ]; then
  TMUX_SESSION="$(har_tmux_session "$AGENT_ID")"
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    tmux kill-session -t "$TMUX_SESSION"
  fi
  tmux new-session -d -s "$TMUX_SESSION" -c "$WORK_DIR" \
    "set -a; [ -f '$ENV_FILE' ] && . '$ENV_FILE'; set +a; exec claude"
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

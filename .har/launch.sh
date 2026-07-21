#!/usr/bin/env bash
# Launch an agent slot for CLI/library repos (git worktree by default, optional Docker infra).
# Every launch starts a FRESH session: any previous session for the slot is torn
# down (its branch is kept) and a new suffixed worktree is created from HEAD.
#
# Usage: ./.har/launch.sh <agent-id> [--no-worktree] [--replace] [--force] [--resume]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

AGENT_ID="${1:-}"
USE_WORKTREE="${HARNESS_USE_WORKTREE:-true}"
FORCE=false
REPLACE=false
RESUME=false
PURPOSE="${HAR_SESSION_PURPOSE:-}"

for arg in "$@"; do
  case "$arg" in
    --no-worktree) USE_WORKTREE=false ;;
    --worktree) USE_WORKTREE=true ;;
    --replace)  REPLACE=true ;;
    --force)    FORCE=true ;;
    --resume)   RESUME=true ;;
    --purpose=*) PURPOSE="${arg#--purpose=}" ;;
  esac
done

if [[ -z "$AGENT_ID" ]]; then
  har_load_agent_slot_limits
  echo "Usage: $0 <agent-id> [--no-worktree] [--replace] [--force] [--resume] [--purpose=label]" >&2
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
  har_launch_preflight "$AGENT_ID" "$FORCE" "$REPLACE" || exit $?

  if slot_is_occupied "$AGENT_ID"; then
    require_slot_replace_confirm "$AGENT_ID" "$FORCE" "$REPLACE"
    log "Replacing previous session for slot ${AGENT_ID}..."
    "$SCRIPT_DIR/teardown.sh" "$AGENT_ID" >&2
  fi
fi

"$SCRIPT_DIR/setup-infra.sh"

if [ "$RESUME" != true ]; then
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
  har_regenerate_agent_env_file "$AGENT_ID" "$WORK_DIR" "$ENV_FILE" "${WORKTREE_DIR:-}"

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
  SLOT_PURPOSE="${PURPOSE}" \
  SLOT_STATUS="starting" \
    write_slot_registry
  REGISTRY_WRITTEN=true
else
  REL_PREFIX="$(git -C "$REPO_ROOT" rev-parse --show-prefix 2>/dev/null || true)"
  log "Resuming session at ${WORK_DIR}"
  har_regenerate_agent_env_file "$AGENT_ID" "$WORK_DIR" "$ENV_FILE" "${WORKTREE_DIR:-}"
  SLOT_AGENT_ID="$AGENT_ID" \
  SLOT_MODE="$([ "$USE_WORKTREE" = true ] && echo worktree || echo root)" \
  SLOT_WORK_DIR="$WORK_DIR" \
  SLOT_SUFFIX="${SUFFIX:-}" \
  SLOT_WORKTREE_PATH="${WORKTREE_DIR:-}" \
  SLOT_BRANCH="${BRANCH:-}" \
  SLOT_BASE_BRANCH="${BASE_BRANCH:-}" \
  SLOT_BASE_COMMIT="${BASE_COMMIT:-}" \
  SLOT_PURPOSE="${PURPOSE}" \
  SLOT_STATUS="starting" \
    write_slot_registry
fi

if [ "$RESUME" = true ] && har_toolchain_ready "$WORK_DIR"; then
  log "Toolchain already provisioned — skipping install."
elif [ -f "$SCRIPT_DIR/provision-toolchain.sh" ]; then
  log "Provisioning toolchain (see harness.env: HARNESS_ECOSYSTEM, HARNESS_INSTALL_CMD)..."
  HAR_WORK_DIR="$WORK_DIR" \
  HAR_ENV_FILE="$ENV_FILE" \
  HAR_WORKTREE_DIR="${WORKTREE_DIR:-}" \
  HAR_REL_PREFIX="${REL_PREFIX:-}" \
  HAR_AGENT_ID="$AGENT_ID" \
    "$SCRIPT_DIR/provision-toolchain.sh"
elif [ -f "$WORK_DIR/package.json" ] && [ ! -d "$WORK_DIR/node_modules" ]; then
  log "Installing dependencies in $WORK_DIR..."
  (cd "$WORK_DIR" && npm install --silent)
fi

SLOT_AGENT_ID="$AGENT_ID" \
SLOT_MODE="$([ "$USE_WORKTREE" = true ] && echo worktree || echo root)" \
SLOT_WORK_DIR="$WORK_DIR" \
SLOT_SUFFIX="${SUFFIX:-}" \
SLOT_WORKTREE_PATH="${WORKTREE_DIR:-}" \
SLOT_BRANCH="${BRANCH:-}" \
SLOT_BASE_BRANCH="${BASE_BRANCH:-}" \
SLOT_BASE_COMMIT="${BASE_COMMIT:-}" \
SLOT_PURPOSE="${PURPOSE}" \
SLOT_STATUS="active" \
  write_slot_registry

log "Agent $AGENT_ID is ready."
log ""
log "  WORK DIR (make ALL file edits under this path — never the main checkout):"
log "    ${WORK_DIR}"
if [ "$USE_WORKTREE" = true ]; then
  log "  Branch:    ${BRANCH} (based on ${BASE_BRANCH} @ ${BASE_COMMIT})"
fi
log ""
log "  Verify:    ./.har/verify.sh $AGENT_ID"
log "  Teardown:  ./.har/teardown.sh $AGENT_ID   (keeps the branch)"

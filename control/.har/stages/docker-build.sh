#!/usr/bin/env bash
# Build the Mission Control Docker image (no push) and smoke-boot it.
# Catches Dockerfile / next build / first-boot (prisma db push) regressions
# before release publish.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/docker-build.sh <agent-id>
# Prerequisite: ./.har/launch.sh <agent-id> (uses the session worktree as context)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$HARNESS_DIR/harness.env"
# shellcheck source=/dev/null
source "$HARNESS_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: docker-build.sh <agent-id>}"
validate_agent_id "$AGENT_ID"

log() { echo "==> [docker-build agent-$AGENT_ID] $*" >&2; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for the docker-build stage" >&2
  exit 1
fi

ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT")" || {
  echo "No .env.agent.${AGENT_ID} found." >&2
  har_suggest_launch "$AGENT_ID" >&2
  exit 1
}

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE")"
# control/ is the app root; Dockerfile context is the monorepo root above it.
MONOREPO_ROOT="$(cd "$WORK_DIR/.." && pwd)"
DOCKERFILE="$MONOREPO_ROOT/control/Dockerfile"
IMAGE_TAG="har-control:verify-agent-${AGENT_ID}"
CONTAINER_NAME="har-control-verify-agent-${AGENT_ID}"
# High port unique per agent — avoid colliding with har control up (3847) / slots.
SMOKE_PORT=$(( 18000 + AGENT_ID ))
ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/docker-build"
mkdir -p "$ARTIFACT_DIR"

if [ ! -f "$DOCKERFILE" ]; then
  echo "Missing Dockerfile at $DOCKERFILE" >&2
  exit 1
fi

cleanup_smoke() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup_smoke EXIT

log "Building $IMAGE_TAG from $MONOREPO_ROOT (file: control/Dockerfile)"
log "Native platform only — release CI still builds linux/amd64 + linux/arm64"

START_TOTAL=$(now_ms)

set +e
BUILD_OUTPUT=$(docker build \
  --file "$DOCKERFILE" \
  --tag "$IMAGE_TAG" \
  --progress=plain \
  "$MONOREPO_ROOT" 2>&1)
BUILD_EXIT=$?
set -e

echo "$BUILD_OUTPUT" >&2
printf '%s\n' "$BUILD_OUTPUT" >"$ARTIFACT_DIR/build-agent-${AGENT_ID}.log"

if [ "$BUILD_EXIT" -ne 0 ]; then
  END_TOTAL=$(now_ms)
  TOTAL_MS=$(( END_TOTAL - START_TOTAL ))
  node -e "
const out = {
  status: 'fail',
  stageId: 'docker-build',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  image: '${IMAGE_TAG}',
  smoke: 'skipped',
  artifacts: [
    { path: '.har/artifacts/docker-build', kind: 'directory' },
  ],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"
  exit "$BUILD_EXIT"
fi

log "Smoke-booting $IMAGE_TAG as $CONTAINER_NAME on localhost:${SMOKE_PORT}"
cleanup_smoke

set +e
SMOKE_RUN_OUTPUT=$(docker run -d \
  --name "$CONTAINER_NAME" \
  -p "${SMOKE_PORT}:3847" \
  -e DATABASE_URL="file:/data/har_control.db" \
  "$IMAGE_TAG" 2>&1)
SMOKE_RUN_EXIT=$?
set -e

printf '%s\n' "$SMOKE_RUN_OUTPUT" >"$ARTIFACT_DIR/smoke-run-agent-${AGENT_ID}.log"
if [ "$SMOKE_RUN_EXIT" -ne 0 ]; then
  echo "$SMOKE_RUN_OUTPUT" >&2
  echo "Failed to start smoke container" >&2
  END_TOTAL=$(now_ms)
  TOTAL_MS=$(( END_TOTAL - START_TOTAL ))
  node -e "
const out = {
  status: 'fail',
  stageId: 'docker-build',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  image: '${IMAGE_TAG}',
  smoke: 'start-failed',
  artifacts: [
    { path: '.har/artifacts/docker-build', kind: 'directory' },
  ],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"
  exit 1
fi

HEALTH_URL="http://127.0.0.1:${SMOKE_PORT}/api/health"
SMOKE_OK=0
SMOKE_LOG=""
for i in $(seq 1 60); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    SMOKE_OK=1
    log "Smoke health check passed (${HEALTH_URL})"
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -qx true; then
    SMOKE_LOG="$(docker logs "$CONTAINER_NAME" 2>&1 || true)"
    echo "$SMOKE_LOG" >&2
    printf '%s\n' "$SMOKE_LOG" >"$ARTIFACT_DIR/smoke-logs-agent-${AGENT_ID}.log"
    echo "Smoke container exited before becoming healthy" >&2
    break
  fi
  sleep 2
done

if [ "$SMOKE_OK" -ne 1 ]; then
  if [ -z "$SMOKE_LOG" ]; then
    SMOKE_LOG="$(docker logs "$CONTAINER_NAME" 2>&1 || true)"
    echo "$SMOKE_LOG" >&2
    printf '%s\n' "$SMOKE_LOG" >"$ARTIFACT_DIR/smoke-logs-agent-${AGENT_ID}.log"
  fi
  echo "Smoke health check failed for ${HEALTH_URL}" >&2
  END_TOTAL=$(now_ms)
  TOTAL_MS=$(( END_TOTAL - START_TOTAL ))
  node -e "
const out = {
  status: 'fail',
  stageId: 'docker-build',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  image: '${IMAGE_TAG}',
  smoke: 'health-failed',
  healthUrl: '${HEALTH_URL}',
  artifacts: [
    { path: '.har/artifacts/docker-build', kind: 'directory' },
  ],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"
  exit 1
fi

docker logs "$CONTAINER_NAME" >"$ARTIFACT_DIR/smoke-logs-agent-${AGENT_ID}.log" 2>&1 || true
cleanup_smoke
trap - EXIT

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

node -e "
const out = {
  status: 'pass',
  stageId: 'docker-build',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  image: '${IMAGE_TAG}',
  smoke: 'pass',
  healthUrl: '${HEALTH_URL}',
  artifacts: [
    { path: '.har/artifacts/docker-build', kind: 'directory' },
  ],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

exit 0

#!/usr/bin/env bash
# Build the Mission Control Docker image (no push) for the agent worktree.
# Catches Dockerfile / next build regressions before release publish.
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
ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/docker-build"
mkdir -p "$ARTIFACT_DIR"

if [ ! -f "$DOCKERFILE" ]; then
  echo "Missing Dockerfile at $DOCKERFILE" >&2
  exit 1
fi

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

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

echo "$BUILD_OUTPUT" >&2
printf '%s\n' "$BUILD_OUTPUT" >"$ARTIFACT_DIR/build-agent-${AGENT_ID}.log"

node -e "
const out = {
  status: ${BUILD_EXIT} === 0 ? 'pass' : 'fail',
  stageId: 'docker-build',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  image: '${IMAGE_TAG}',
  artifacts: [
    { path: '.har/artifacts/docker-build', kind: 'directory' },
  ],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

exit "$BUILD_EXIT"

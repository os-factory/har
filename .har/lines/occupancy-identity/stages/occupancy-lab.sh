#!/usr/bin/env bash
# occupancy-lab — station S3 of the occupancy-identity factory line (#316).
#
# Two occupancies of slot 1 driven by the REAL har CLI against a real Mission
# Control database, inside a container with an isolated HOME. On a laptop,
# ~/.claude/projects/<encoded-cwd> transcripts outlive the worktree and the
# harvest can re-attach them to the next occupancy, so a green host run can just
# mean the machine was clean. The sandbox removes that reading.
#
# Registered in stages.json and deliberately ABSENT from verificationStages:
# routine `har env verify --full` must never start Docker. Run it with:
#   har line gate S3 --line occupancy-identity
#
# Usage: ./.har/stages/occupancy-lab.sh <agent-id>
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
LAB_DIR="$TARGET/.har/lines/occupancy-identity/lab"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/occupancy-lab"
IMAGE="${OCCUPANCY_LAB_IMAGE:-har-occupancy-lab:latest}"

mkdir -p "$ARTIFACTS_DIR"
now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(0,50).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}
emit() {
  node -e "process.stdout.write(JSON.stringify({
    status: '$1', stageId: 'occupancy-lab', kind: 'test', agent_id: $AGENT_ID,
    total_ms: $2, output: $3
  }, null, 2) + '\n');"
}

START=$(now_ms)

if ! docker info >/dev/null 2>&1; then
  # A missing Docker daemon is a real blocker for this station, not a pass.
  emit fail "$(( $(now_ms) - START ))" "\"Docker daemon is not reachable — station S3 needs it. Start Docker, or run the earlier stations with: har line gate S2 --line occupancy-identity\""
  exit 1
fi

[ -d "$LAB_DIR" ] || { emit fail 0 "\"lab directory missing: $LAB_DIR\""; exit 1; }

echo "==> [occupancy-lab agent-${AGENT_ID}] building $IMAGE" >&2
set +e
BUILD_LOG=$(docker build -q -t "$IMAGE" -f "$LAB_DIR/Dockerfile" "$LAB_DIR" 2>&1)
BUILD_CODE=$?
set -e
if [ "$BUILD_CODE" != "0" ]; then
  emit fail "$(( $(now_ms) - START ))" "$(escape_step_output "$BUILD_LOG")"
  exit 1
fi

echo "==> [occupancy-lab agent-${AGENT_ID}] running the occupancy cycle in a sandbox HOME" >&2
set +e
# The repo is mounted read-write: the lab builds nothing in it, but the har CLI
# writes run records under the mounted .har/ of the scratch fixture it creates.
OUTPUT=$(docker run --rm \
  -v "$TARGET:/lab/repo" \
  -e LAB_REPO_ROOT=/lab/repo \
  -e OCCUPANCY_LAB_ARTIFACTS=/lab/repo/.har/artifacts/occupancy-lab \
  -e OCCUPANCY_LAB_KEEP="${OCCUPANCY_LAB_KEEP:-0}" \
  "$IMAGE" 2>&1)
RUN_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/lab.log"

END=$(now_ms)
STATUS="fail"
[ "$RUN_CODE" = "0" ] && STATUS="pass"
emit "$STATUS" "$(( END - START ))" "$(escape_step_output "$OUTPUT")"
exit "$RUN_CODE"

#!/usr/bin/env bash
# occupancy-s1 — trajectory and usage are scoped to the occupancy, not the slot id
#
# Station S1 of the occupancy-identity factory line (#316).
# Registered in stages.json; deliberately ABSENT from verificationStages —
# run it with: har line gate S1 --line occupancy-identity
#
# Usage: ./.har/stages/occupancy-s1.sh <agent-id>
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
STATION="$(echo s1 | tr '[:lower:]' '[:upper:]')"

# Run against the slot's own checkout when there is one, else the main repo.
TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/occupancy-s1"
mkdir -p "$ARTIFACTS_DIR"

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(0,50).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}

echo "==> [occupancy-s1 agent-${AGENT_ID}] ${STATION}: trajectory and usage are scoped to the occupancy, not the slot id" >&2
echo "==> target: $TARGET/control" >&2
START=$(now_ms)

set +e
OUTPUT=$(cd "$TARGET/control" && npx vitest run src/server/occupancy.test.ts --testNamePattern "$STATION" --reporter dot 2>&1)
EXIT_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/vitest.log"

END=$(now_ms)
STATUS="fail"
[ "$EXIT_CODE" = "0" ] && STATUS="pass"
OUTPUT_JSON=$(escape_step_output "$OUTPUT")

node -e "process.stdout.write(JSON.stringify({
  status: '$STATUS',
  stageId: 'occupancy-s1',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $(( END - START )),
  output: $OUTPUT_JSON
}, null, 2) + '\n');"

exit "$EXIT_CODE"

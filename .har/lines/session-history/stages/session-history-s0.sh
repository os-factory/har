#!/usr/bin/env bash
# session-history-s0 — snapshot and commit stay distinct
#
# Station S0 of the session-history factory line (#191).
# Registered in stages.json; deliberately ABSENT from verificationStages.
#
# Usage: ./.har/stages/session-history-s0.sh <agent-id>
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/session-history-s0"
mkdir -p "$ARTIFACTS_DIR"

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(0,50).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}

echo "==> [session-history-s0 agent-${AGENT_ID}] graph assembler + commit bindings" >&2
START=$(now_ms)

set +e
OUTPUT=$(cd "$TARGET" && npx jest tests/session-history.test.ts tests/commit-bindings.test.ts --forceExit 2>&1)
EXIT_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/jest.log"

END=$(now_ms)
STATUS="fail"
[ "$EXIT_CODE" = "0" ] && STATUS="pass"
OUTPUT_JSON=$(escape_step_output "$OUTPUT")

node -e "process.stdout.write(JSON.stringify({
  status: '$STATUS',
  stageId: 'session-history-s0',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $(( END - START )),
  output: $OUTPUT_JSON
}, null, 2) + '\n');"

exit "$EXIT_CODE"

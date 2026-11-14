#!/usr/bin/env bash
# usage-integrity-e2e — Mission Control from source, har control sync, capture portal (no Docker, no model)
#
# Station S1 of the usage-integrity factory line (FE-2058).
# Registered in stages.json; deliberately ABSENT from verificationStages.
#
# Usage: ./.har/stages/usage-integrity-e2e.sh <agent-id>
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/usage-integrity-e2e"
mkdir -p "$ARTIFACTS_DIR"

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\\n').slice(0,50).join('\\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}

echo "==> [usage-integrity-e2e agent-${AGENT_ID}] Mission Control from source, har control sync, capture portal (no Docker, no model)" >&2
START=$(now_ms)

set +e
OUTPUT=$(cd "$TARGET" && { ([ -f dist/index.js ] || npm run build >/dev/null) && HAR_USAGE_E2E=1 npx jest tests/usage-integrity.e2e.test.ts --forceExit; } 2>&1)
EXIT_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/e2e.log"

END=$(now_ms)
STATUS="fail"
[ "$EXIT_CODE" = "0" ] && STATUS="pass"
OUTPUT_JSON=$(escape_step_output "$OUTPUT")

node -e "process.stdout.write(JSON.stringify({
  status: '$STATUS',
  stageId: 'usage-integrity-e2e',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $(( END - START )),
  output: $OUTPUT_JSON
}, null, 2) + '\n');"

exit "$EXIT_CODE"

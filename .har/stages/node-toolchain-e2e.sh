#!/usr/bin/env bash
# node-toolchain-e2e — real slots pin an installed Node that satisfies the harness engines (no Docker)
#
# Built CLI → env launch / run-stage / verify / doctor against fake nvm installs in a sandbox HOME.
# Registered in stages.json; deliberately ABSENT from verificationStages.
#
# Usage: ./.har/stages/node-toolchain-e2e.sh <agent-id>
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/node-toolchain-e2e"
mkdir -p "$ARTIFACTS_DIR"

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\\n').slice(0,50).join('\\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}

echo "==> [node-toolchain-e2e agent-${AGENT_ID}] built CLI pins Node for real slots (no Docker)" >&2
START=$(now_ms)

set +e
OUTPUT=$(cd "$TARGET" && { ([ -f dist/index.js ] || npm run build >/dev/null) && HAR_NODE_TOOLCHAIN_E2E=1 npx jest tests/node-toolchain.e2e.test.ts --forceExit; } 2>&1)
EXIT_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/e2e.log"

END=$(now_ms)
STATUS="fail"
[ "$EXIT_CODE" = "0" ] && STATUS="pass"
OUTPUT_JSON=$(escape_step_output "$OUTPUT")

node -e "process.stdout.write(JSON.stringify({
  status: '$STATUS',
  stageId: 'node-toolchain-e2e',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $(( END - START )),
  output: $OUTPUT_JSON
}, null, 2) + '\n');"

exit "$EXIT_CODE"

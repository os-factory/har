#!/usr/bin/env bash
# occupancy-agent-lab — the adversarial half of station S3 (#316).
#
# The Docker lab (occupancy-lab) proves the invariant against synthetic records.
# This one reproduces the condition the bug was found in: a REAL Claude Code CLI
# driven twice against a scripted LLM mock, across a launch → complete → launch
# boundary on the same slot, under a sandbox HOME so the transcripts it writes
# are the lab's own and not the developer's.
#
# Nothing talks to a real model: ANTHROPIC_BASE_URL points at the local mock.
#
# Registered in stages.json and deliberately ABSENT from verificationStages.
# Run it with: har line gate S3 --line occupancy-identity
#
# Usage: ./.har/stages/occupancy-agent-lab.sh <agent-id>
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
DRIVER="$TARGET/.har/lines/occupancy-identity/lab/agent/run-agent-lab.mjs"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/occupancy-agent-lab"

mkdir -p "$ARTIFACTS_DIR"
now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
emit() {
  node -e "process.stdout.write(JSON.stringify({
    status: '$1', stageId: 'occupancy-agent-lab', kind: 'test', agent_id: $AGENT_ID,
    total_ms: $2, output: $3
  }, null, 2) + '\n');"
}

START=$(now_ms)

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
if [ -z "$CLAUDE_BIN" ]; then
  # A missing agent CLI is a real blocker for this station, not a pass. The
  # earlier stations still answer their questions without it.
  emit fail "$(( $(now_ms) - START ))" "\"claude CLI not found — station S3's agent lab needs it (set CLAUDE_BIN, or run the unit stations with: har line gate S2 --line occupancy-identity)\""
  exit 1
fi

[ -f "$DRIVER" ] || { emit fail 0 "\"lab driver missing: $DRIVER\""; exit 1; }

echo "==> [occupancy-agent-lab agent-${AGENT_ID}] two real agent sessions across an occupancy boundary" >&2

set +e
OUTPUT=$(cd "$TARGET" && OCCUPANCY_LAB_ARTIFACTS="$ARTIFACTS_DIR" LAB_REPO_ROOT="$TARGET" \
  CLAUDE_BIN="$CLAUDE_BIN" node "$DRIVER" 2>&1)
RUN_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/agent-lab.log"

END=$(now_ms)
STATUS="fail"
[ "$RUN_CODE" = "0" ] && STATUS="pass"
SUMMARY=$(printf '%s' "$OUTPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(-40).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""')
emit "$STATUS" "$(( END - START ))" "$SUMMARY"
exit "$RUN_CODE"

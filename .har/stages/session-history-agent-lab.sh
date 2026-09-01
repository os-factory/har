#!/usr/bin/env bash
# session-history-agent-lab — station S1 of the session-history line (#191).
#
# Real Claude Code CLI against a scripted mock, then full verify and commit.
# Asserts the content snapshot and the commit stay linked by tree identity.
#
# Usage: ./.har/stages/session-history-agent-lab.sh <agent-id>
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
DRIVER="$TARGET/.har/lines/session-history/lab/agent/run-agent-lab.mjs"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/session-history-agent-lab"

mkdir -p "$ARTIFACTS_DIR"
now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }
emit() {
  node -e "process.stdout.write(JSON.stringify({
    status: '$1', stageId: 'session-history-agent-lab', kind: 'test', agent_id: $AGENT_ID,
    total_ms: $2, output: $3
  }, null, 2) + '\n');"
}

START=$(now_ms)

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
if [ -z "$CLAUDE_BIN" ]; then
  emit fail "$(( $(now_ms) - START ))" "\"claude CLI not found — station S1 needs it (set CLAUDE_BIN, or run S0 with: har line gate S0 --line session-history)\""
  exit 1
fi

[ -f "$DRIVER" ] || { emit fail 0 "\"lab driver missing: $DRIVER\""; exit 1; }

echo "==> [session-history-agent-lab agent-${AGENT_ID}] session → verify → commit → bind" >&2

set +e
OUTPUT=$(cd "$TARGET" && SESSION_HISTORY_LAB_ARTIFACTS="$ARTIFACTS_DIR" LAB_REPO_ROOT="$TARGET" \
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

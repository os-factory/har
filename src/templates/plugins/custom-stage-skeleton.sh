#!/usr/bin/env bash
# __STAGE_DESCRIPTION__
# Custom HAR stage: __STAGE_ID__ (kind: __STAGE_KIND__)
#
# Stage script contract (full reference: .har/STAGES.md):
#   - stdout: a single JSON result object (status, stageId, agent_id, ...)
#   - stderr: human-readable progress
#   - $1: agent slot id; extra args may follow
#   - artifacts: write reports/screenshots/logs under .har/artifacts/__STAGE_ID__/
#   - exit code: the real status (0 = pass)
#
# Usage: ./.har/stages/__STAGE_ID__.sh <agent-id> [extra args...]
set -euo pipefail

# 1.0 stage surface: the runner exports WORK_DIR, ENV_FILE, AGENT_ID and
# HAR_HARNESS_DIR, with harness.env and the slot env file already sourced —
# agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

AGENT_ID="${1:-${AGENT_ID:?Usage: __STAGE_ID__.sh <agent-id> [extra args...]}}"
now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }

# JSON-escape step output; truncate to 50 lines in node (avoids SIGPIPE under pipefail).
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(0,50).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}

ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/__STAGE_ID__"
mkdir -p "$ARTIFACTS_DIR"

echo "==> [__STAGE_ID__ agent-${AGENT_ID}] running in ${WORK_DIR}" >&2
START=$(now_ms)

# ── TODO: implement the stage ────────────────────────────────────────────────
# Run your checks from $WORK_DIR (the agent's isolated checkout); the slot's
# ports and env are loaded from $ENV_FILE. Save artifacts to $ARTIFACTS_DIR.
set +e
OUTPUT=$(cd "$WORK_DIR" && echo "TODO: implement .har/stages/__STAGE_ID__.sh" && false)
EXIT_CODE=$?
set -e

END=$(now_ms)
STATUS="fail"
[ "$EXIT_CODE" = "0" ] && STATUS="pass"
OUTPUT_JSON=$(escape_step_output "$OUTPUT")

node -e "process.stdout.write(JSON.stringify({
  status: '$STATUS',
  stageId: '__STAGE_ID__',
  kind: '__STAGE_KIND__',
  agent_id: $AGENT_ID,
  total_ms: $(( END - START )),
  output: $OUTPUT_JSON
}, null, 2) + '\n');"

exit "$EXIT_CODE"

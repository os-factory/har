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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
# agent-slot.sh expects SCRIPT_DIR to be .har/ (slot registry lives there)
SCRIPT_DIR="$HARNESS_DIR"

# shellcheck source=/dev/null
source "$HARNESS_DIR/harness.env"
# shellcheck source=/dev/null
source "$HARNESS_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: __STAGE_ID__.sh <agent-id> [extra args...]}"
validate_agent_id "$AGENT_ID"

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

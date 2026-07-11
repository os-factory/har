#!/usr/bin/env bash
# Playwright browser/API/a11y tests for an agent slot.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/browser-e2e.sh <agent-id>
# Prerequisite: ./.har/launch.sh <agent-id>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$HARNESS_DIR/harness.env"
# shellcheck source=/dev/null
source "$HARNESS_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: browser-e2e.sh <agent-id>}"
validate_agent_id "$AGENT_ID"

log() { echo "==> [browser-e2e agent-$AGENT_ID] $*" >&2; }

ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT")" || {
  echo "No .env.agent.${AGENT_ID} found. Run: ./.har/launch.sh ${AGENT_ID}" >&2
  exit 1
}

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE")"
FE_PORT="${FE_PORT:-$(( HARNESS_FE_BASE_PORT + AGENT_ID * 10 ))}"
API_PORT="${API_PORT:-$(( HARNESS_API_BASE_PORT + AGENT_ID * 10 ))}"

export BASE_URL="${BASE_URL:-http://localhost:${FE_PORT}}"
export API_URL="${API_URL:-http://localhost:${API_PORT}}"

ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/browser-e2e"
mkdir -p "$ARTIFACT_DIR"

log "Running Playwright against $BASE_URL (API: $API_URL)"
log "Work dir: $WORK_DIR"

START_TOTAL=$(now_ms)

set +e
cd "$WORK_DIR"
PW_OUTPUT=$(npx playwright test 2>&1)
PW_EXIT=$?
set -e

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

echo "$PW_OUTPUT" >&2

REPORT_DIR="$ARTIFACT_DIR/playwright-report"
REPORT_INDEX="$REPORT_DIR/index.html"

node -e "
const out = {
  status: ${PW_EXIT} === 0 ? 'pass' : 'fail',
  stageId: 'browser-e2e',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  urls: [
    { label: 'frontend', url: process.env.BASE_URL || '${BASE_URL}' },
    { label: 'api', url: process.env.API_URL || '${API_URL}' },
  ],
  artifacts: [
    { path: '.har/artifacts/browser-e2e', kind: 'directory' },
  ],
};
if (require('fs').existsSync('${REPORT_INDEX}')) {
  out.artifacts.push({ path: '.har/artifacts/browser-e2e/playwright-report', kind: 'report' });
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

exit "$PW_EXIT"

#!/usr/bin/env bash
# Capture full-page screenshots for an agent slot (before or after UI work).
#
# Usage: ./.har/stages/capture-screenshots.sh <agent-id> [before|after]
# Prerequisite: ./.har/launch.sh <agent-id> (site must be healthy)
#
# Writes PNGs under:
#   .har/artifacts/browser-e2e/screenshots/<phase>/
# and attaches them via the Playwright visual-proof project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
SCRIPT_DIR="$HARNESS_DIR"

# shellcheck source=/dev/null
source "$HARNESS_DIR/harness.env"
# shellcheck source=/dev/null
source "$HARNESS_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: capture-screenshots.sh <agent-id> [before|after]}"
PHASE="${2:-after}"
case "$PHASE" in
  before|after) ;;
  *)
    echo "Phase must be 'before' or 'after' (got: $PHASE)" >&2
    exit 1
    ;;
esac

validate_agent_id "$AGENT_ID"

log() { echo "==> [screenshots agent-$AGENT_ID $PHASE] $*" >&2; }

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
FE_PORT="${FE_PORT:-$(( HARNESS_FE_BASE_PORT + AGENT_ID * ${HARNESS_PORT_STEP:-10} ))}"

export BASE_URL="${BASE_URL:-http://localhost:${FE_PORT}}"
export API_URL="${API_URL:-$BASE_URL}"
export PW_SCREENSHOT_PHASE="$PHASE"
export PW_SCREENSHOT_DIR="$REPO_ROOT/.har/artifacts/browser-e2e/screenshots/${PHASE}"
mkdir -p "$PW_SCREENSHOT_DIR"

log "Capturing ${PHASE} screenshots against $BASE_URL → $PW_SCREENSHOT_DIR"
log "Work dir: $WORK_DIR"

START_TOTAL=$(now_ms)

set +e
cd "$WORK_DIR"
PW_OUTPUT=$(npx playwright test --project=visual-proof 2>&1)
PW_EXIT=$?
set -e

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

echo "$PW_OUTPUT" >&2

node -e "
const fs = require('fs');
const path = require('path');
const dir = process.env.PW_SCREENSHOT_DIR;
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => path.join('.har/artifacts/browser-e2e/screenshots/${PHASE}', f))
  : [];
const out = {
  status: ${PW_EXIT} === 0 ? 'pass' : 'fail',
  stageId: 'capture-screenshots',
  kind: 'test',
  agent_id: ${AGENT_ID},
  phase: '${PHASE}',
  total_ms: ${TOTAL_MS},
  urls: [{ label: 'site', url: process.env.BASE_URL || '${BASE_URL}' }],
  artifacts: [
    { path: '.har/artifacts/browser-e2e/screenshots/${PHASE}', kind: 'directory' },
    ...files.map((path) => ({ path, kind: 'screenshot' })),
  ],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

exit "$PW_EXIT"

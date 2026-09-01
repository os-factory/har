#!/usr/bin/env bash
# Capture full-page screenshots for an agent slot (before or after UI work).
#
# Usage: ./.har/stages/capture-screenshots.sh <agent-id> [before|after]
# Prerequisite: har env launch <agent-id> (site must be healthy)
#
# Writes PNGs under:
#   .har/artifacts/browser-e2e/screenshots/<phase>/
# and attaches them via the Playwright visual-proof project.
set -euo pipefail

# 1.0 stage surface: the runner (and lifecycle hooks) export WORK_DIR,
# ENV_FILE, AGENT_ID and HAR_HARNESS_DIR, with harness.env and the slot env
# file already sourced — agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

AGENT_ID="${1:-${AGENT_ID:?Usage: capture-screenshots.sh <agent-id> [before|after]}}"
PHASE="${2:-after}"
case "$PHASE" in
  before|after) ;;
  *)
    echo "Phase must be 'before' or 'after' (got: $PHASE)" >&2
    exit 1
    ;;
esac

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

log() { echo "==> [screenshots agent-$AGENT_ID $PHASE] $*" >&2; }

ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
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

#!/usr/bin/env bash
# Playwright browser/API/a11y + visual-proof screenshots for an agent slot.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/browser-e2e.sh <agent-id>
# Prerequisite: har env launch <agent-id>
#
# Screenshot contract
# -------------------
# Launch captures "before" shots (baseline at session start).
# Full verify / this stage captures "after" shots proving the completed UI.
# Artifacts (gitignored):
#   .har/artifacts/browser-e2e/screenshots/before/
#   .har/artifacts/browser-e2e/screenshots/after/
#   .har/artifacts/browser-e2e/playwright-report/
#
# UI change tasks MUST add or update specs under tests/frontend/ and present
# the after (and before, when present) screenshot paths in the session handoff.
set -euo pipefail

# 1.0 stage surface: the runner exports WORK_DIR, ENV_FILE, AGENT_ID and
# HAR_HARNESS_DIR, with harness.env and the slot env file already sourced —
# agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

AGENT_ID="${1:-${AGENT_ID:?Usage: browser-e2e.sh <agent-id>}}"
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

log() { echo "==> [browser-e2e agent-$AGENT_ID] $*" >&2; }

ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
FE_PORT="${FE_PORT:-$(( HARNESS_FE_BASE_PORT + AGENT_ID * ${HARNESS_PORT_STEP:-10} ))}"
API_PORT="${API_PORT:-$FE_PORT}"

export BASE_URL="${BASE_URL:-http://localhost:${FE_PORT}}"
export API_URL="${API_URL:-http://localhost:${API_PORT}}"
export HARNESS_HEALTH_PATH="${HARNESS_HEALTH_CHECK_PATH:-/}"
export PW_SCREENSHOT_PHASE=after
export PW_SCREENSHOT_DIR="$REPO_ROOT/.har/artifacts/browser-e2e/screenshots/after"

ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/browser-e2e"
mkdir -p "$ARTIFACT_DIR" "$PW_SCREENSHOT_DIR"

log "Running Playwright (frontend + api + visual-proof) against $BASE_URL"
log "After screenshots → $PW_SCREENSHOT_DIR"
log "Work dir: $WORK_DIR"

# Ensure Chromium is available (no-op if already installed)
(cd "$WORK_DIR" && npx playwright install chromium >/dev/null 2>&1) || true

START_TOTAL=$(now_ms)

set +e
cd "$WORK_DIR"
# Default harness e2e skips the optional a11y project (known marketing-site debt).
PW_OUTPUT=$(npx playwright test --project=frontend --project=api --project=visual-proof 2>&1)
PW_EXIT=$?
set -e

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

echo "$PW_OUTPUT" >&2

REPORT_DIR="$ARTIFACT_DIR/playwright-report"
REPORT_INDEX="$REPORT_DIR/index.html"

node -e "
const fs = require('fs');
const path = require('path');
const shotDir = process.env.PW_SCREENSHOT_DIR;
const shots = fs.existsSync(shotDir)
  ? fs.readdirSync(shotDir).filter((f) => f.endsWith('.png')).map((f) => path.join('.har/artifacts/browser-e2e/screenshots/after', f))
  : [];
const out = {
  status: ${PW_EXIT} === 0 ? 'pass' : 'fail',
  stageId: 'browser-e2e',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  urls: [
    { label: 'site', url: process.env.BASE_URL || '${BASE_URL}' },
  ],
  artifacts: [
    { path: '.har/artifacts/browser-e2e', kind: 'directory' },
    { path: '.har/artifacts/browser-e2e/screenshots/after', kind: 'directory' },
    ...shots.map((p) => ({ path: p, kind: 'screenshot' })),
  ],
};
if (fs.existsSync('${REPORT_INDEX}')) {
  out.artifacts.push({ path: '.har/artifacts/browser-e2e/playwright-report', kind: 'report' });
}
const beforeDir = '${ARTIFACT_DIR}/screenshots/before';
if (fs.existsSync(beforeDir) && fs.readdirSync(beforeDir).some((f) => f.endsWith('.png'))) {
  out.artifacts.push({ path: '.har/artifacts/browser-e2e/screenshots/before', kind: 'directory' });
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

exit "$PW_EXIT"

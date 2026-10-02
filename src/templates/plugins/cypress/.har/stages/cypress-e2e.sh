#!/usr/bin/env bash
# Cypress end-to-end tests for an agent slot.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/cypress-e2e.sh <agent-id>
# Prerequisite: har env launch <agent-id> AND npm install (Cypress binary)
# See: ./.har/stages/CYPRESS.md
set -euo pipefail

# 1.0 stage surface: the runner exports WORK_DIR, ENV_FILE, AGENT_ID and
# HAR_HARNESS_DIR, with harness.env and the slot env file already sourced —
# agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

AGENT_ID="${1:-${AGENT_ID:?Usage: cypress-e2e.sh <agent-id>}}"

# Direct invocation (the manifest nextSteps) has no runner in front of it.
# Recover the slot work dir from the registry launch wrote.
if [ -z "${ENV_FILE:-}" ] || [ -z "${WORK_DIR:-}" ]; then
  SLOT_FILE="$HARNESS_DIR/slots/agent-${AGENT_ID}.json"
  if [ -f "$SLOT_FILE" ]; then
    SLOT_WORK="$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(s.workDir||"")' "$SLOT_FILE" 2>/dev/null || true)"
    if [ -n "$SLOT_WORK" ] && [ -f "$SLOT_WORK/.env.agent.${AGENT_ID}" ]; then
      WORK_DIR="$SLOT_WORK"
      ENV_FILE="$SLOT_WORK/.env.agent.${AGENT_ID}"
      set -a
      # shellcheck disable=SC1091
      [ -f "$HARNESS_DIR/harness.env" ] && . "$HARNESS_DIR/harness.env"
      # shellcheck disable=SC1090
      . "$ENV_FILE"
      set +a
    fi
  fi
fi

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }

log() { echo "==> [cypress-e2e agent-$AGENT_ID] $*" >&2; }

ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"

FE_PORT="${FE_PORT:-$(( ${HARNESS_FE_BASE_PORT:-3000} + AGENT_ID * 10 ))}"
API_PORT="${API_PORT:-$(( ${HARNESS_API_BASE_PORT:-8000} + AGENT_ID * 10 ))}"

export BASE_URL="${BASE_URL:-http://localhost:${FE_PORT}}"
export API_URL="${API_URL:-http://localhost:${API_PORT}}"
export CYPRESS_BASE_URL="${CYPRESS_BASE_URL:-$BASE_URL}"
export CYPRESS_API_URL="${CYPRESS_API_URL:-$API_URL}"
HEALTH_PATH="${HARNESS_HEALTH_CHECK_PATH:-${HARNESS_HEALTH_PATH:-/health}}"
export CYPRESS_HEALTH_PATH="${CYPRESS_HEALTH_PATH:-$HEALTH_PATH}"

# Artifacts land next to this harness (main checkout), not inside a worktree
# whose .env.agent file may rewrite REPO_ROOT.
ARTIFACT_DIR="$(cd "$HARNESS_DIR/.." && pwd)/.har/artifacts/cypress-e2e"
mkdir -p "$ARTIFACT_DIR"
export HARNESS_CYPRESS_ARTIFACT_DIR="$ARTIFACT_DIR"

BROWSER="${HARNESS_CYPRESS_BROWSER:-electron}"
export HARNESS_CYPRESS_BROWSER="$BROWSER"

if [ ! -x "$WORK_DIR/node_modules/.bin/cypress" ]; then
  echo "Error: Cypress is not installed in $WORK_DIR." >&2
  echo "  npm install" >&2
  echo "  npx cypress verify" >&2
  echo "  Then re-run: ./.har/stages/cypress-e2e.sh ${AGENT_ID}" >&2
  exit 1
fi

log "Running Cypress ($BROWSER) against $CYPRESS_BASE_URL (API: $CYPRESS_API_URL)"
log "Work dir: $WORK_DIR"
log "Artifacts: $ARTIFACT_DIR"

START_TOTAL=$(now_ms)
LOG_FILE="$ARTIFACT_DIR/cypress.log"

set +e
(
  cd "$WORK_DIR"
  npx cypress run \
    --e2e \
    --browser "$BROWSER" \
    --posix-exit-codes
) >"$LOG_FILE" 2>&1
CYPRESS_EXIT=$?
set -e

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

if [ "$CYPRESS_EXIT" -eq 0 ]; then
  log "Cypress passed (${TOTAL_MS}ms)"
else
  log "Cypress failed with exit $CYPRESS_EXIT (${TOTAL_MS}ms) — see $LOG_FILE"
  tail -30 "$LOG_FILE" | sed 's/^/    /' >&2
fi

HARNESS_CYPRESS_ARTIFACT_DIR="$ARTIFACT_DIR" node -e "
const fs = require('fs');
const artifactDir = process.env.HARNESS_CYPRESS_ARTIFACT_DIR;
const out = {
  status: ${CYPRESS_EXIT} === 0 ? 'pass' : 'fail',
  stageId: 'cypress-e2e',
  kind: 'test',
  agent_id: ${AGENT_ID},
  total_ms: ${TOTAL_MS},
  exit_code: ${CYPRESS_EXIT},
  browser: process.env.HARNESS_CYPRESS_BROWSER || 'electron',
  urls: [
    { label: 'frontend', url: process.env.CYPRESS_BASE_URL || '' },
    { label: 'api', url: process.env.CYPRESS_API_URL || '' },
  ],
  artifacts: [
    { path: '.har/artifacts/cypress-e2e', kind: 'directory' },
    { path: '.har/artifacts/cypress-e2e/cypress.log', kind: 'log' },
  ],
};
if (fs.existsSync(artifactDir + '/screenshots')) {
  out.artifacts.push({ path: '.har/artifacts/cypress-e2e/screenshots', kind: 'directory' });
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

exit "$CYPRESS_EXIT"

#!/usr/bin/env bash
# Verification pipeline for @osfactory/har.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# Quick (default): typecheck + build + docs check/build
# Full (--full):   + unit tests, lint, readiness, and registered verification stages (docs-drift)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: verify.sh <agent-id> [--full]}"
FULL=""

for arg in "${@:2}"; do
  [ "$arg" = "--full" ] && FULL=1
done

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

WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE" "$AGENT_ID")"

echo "==> Verifying agent ${AGENT_ID} in ${WORK_DIR}..." >&2
REG_FILE="$(slot_registry_file "$AGENT_ID")"
echo "    Work dir: ${WORK_DIR}" >&2
echo "    Env file: ${ENV_FILE}" >&2
if [ -f "$REG_FILE" ]; then
  echo "    Registry: ${REG_FILE}" >&2
else
  echo "    Registry: missing (${REG_FILE})" >&2
fi

OVERALL_PASS=true
START_TOTAL=$(now_ms)
RESULTS_JSON="[]"

run_step() {
  local name="$1"
  local cmd="$2"
  local start end elapsed exit_code output

  printf "  → %-40s" "$name..." >&2
  start=$(now_ms)

  set +e
  output=$(cd "$WORK_DIR" && eval "$cmd" 2>&1)
  exit_code=$?
  set -e

  end=$(now_ms)
  elapsed=$(( end - start ))

  local pass_bool step_output_escaped
  if [ "$exit_code" = "0" ]; then
    echo "✓ (${elapsed}ms)" >&2
    pass_bool="true"
  else
    echo "✗ (${elapsed}ms)" >&2
    echo "$output" | head -30 | sed 's/^/    /' >&2
    pass_bool="false"
    OVERALL_PASS=false
  fi

  step_output_escaped=$(escape_step_output "$output")

  RESULTS_JSON=$(echo "$RESULTS_JSON" | node -e "
const fs = require('fs');
let arr = JSON.parse(fs.readFileSync('/dev/stdin','utf8'));
arr.push({name:'$name',pass:$pass_bool,ms:$elapsed,output:$step_output_escaped});
process.stdout.write(JSON.stringify(arr));
" 2>/dev/null || echo "$RESULTS_JSON")

  if [ "$pass_bool" = "false" ] && [ -z "$FULL" ]; then
    return 1
  fi
}

run_step "typecheck" "npm run typecheck" || { [ -z "$FULL" ] && true; }
# Some unit tests exec dist/index.js (e.g. plugins CLI add-plugin).
run_step "build" "npm run build" || { [ -z "$FULL" ] && true; }
run_step "docs-check" "npm run check --prefix docs" || { [ -z "$FULL" ] && true; }
run_step "docs-build" "npm run build --prefix docs" || { [ -z "$FULL" ] && true; }

if [ -n "$FULL" ]; then
  # Full-mode steps for this repo — customize when adapting the harness elsewhere.
  run_step "unit-tests" "npm test" || true
  run_step "lint" "npm run lint" || true
  run_step "readiness" "run_readiness_if_configured \"$AGENT_ID\"" || true
  # Registered verification stages from .har/stages.json (see .har/STAGES.md).
  # Every stage listed in verificationStages with a registered script/command
  # runs here -- plugins and custom stages alike.
  while IFS=$'\t' read -r STAGE_ID STAGE_CMD; do
    [ -n "$STAGE_ID" ] || continue
    run_step "$STAGE_ID" "$STAGE_CMD" || true
  done < <(list_registered_verification_stage_commands "$SCRIPT_DIR" "$AGENT_ID")
fi

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

node -e "
const results = $RESULTS_JSON;
const overall = results.length > 0 && results.every(r => r.pass);
const out = {
  status: overall ? 'pass' : 'fail',
  agent_id: $AGENT_ID,
  total_ms: $TOTAL_MS,
  stages: results,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
" 2>/dev/null || echo "{\"status\":\"fail\",\"agent_id\":${AGENT_ID},\"stages\":[]}"

if [ "$OVERALL_PASS" = "false" ]; then
  exit 1
fi

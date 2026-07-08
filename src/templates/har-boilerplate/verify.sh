#!/usr/bin/env bash
# Progressive verification pipeline for an agent environment.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# Quick (default): smoke — compile / typecheck / health only
# Full (--full):   + unit tests, lint, optional readiness + browser-e2e
# Step lists are examples — not exhaustive. Adapt commands to this repo's stack.
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

API_PORT=$(( HARNESS_API_BASE_PORT + AGENT_ID * 10 ))

ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT")" || {
  echo "No .env.agent.${AGENT_ID} found. Run: ./.har/launch.sh ${AGENT_ID}" >&2
  exit 1
}

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE")"
API_PORT="${API_PORT:-$(( HARNESS_API_BASE_PORT + AGENT_ID * 10 ))}"

echo "==> Verifying agent ${AGENT_ID} (work dir: ${WORK_DIR})..." >&2
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
  output=$(cd "$WORK_DIR" && set -a && . "$ENV_FILE" && set +a && eval "$cmd" 2>&1)
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

run_http_step() {
  local name="$1"
  local url="$2"
  local start end elapsed exit_code output

  printf "  → %-40s" "$name..." >&2
  start=$(now_ms)

  set +e
  output=$(curl -sf "$url" 2>&1)
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

# ── Verification stages ─────────────────────────────────────────────────────
# Customize these steps for your project — lists below are examples, not exhaustive.
# Edit this section directly — do not use a separate config file.

# Quick (default): smoke — prove the slot can compile/load, not full test suites.
run_step "typecheck" "echo 'TODO: npm run typecheck'" || { [ -z "$FULL" ] && true; }
run_http_step "api-health" "http://localhost:${API_PORT}${HARNESS_HEALTH_CHECK_PATH}" || { [ -z "$FULL" ] && true; }

if [ -n "$FULL" ]; then
  # Full: project-specific checks — add/remove/reorder steps for this repo.
  run_step "unit-tests" "echo 'TODO: npm test'" || true
  run_step "lint" "echo 'TODO: npm run lint'" || true
  run_step "readiness" "run_readiness_if_configured \"$AGENT_ID\"" || true
  run_step "browser-e2e" "run_browser_e2e_if_present \"$SCRIPT_DIR\" \"$AGENT_ID\"" || true
fi

# ── Output results ────────────────────────────────────────────────────────────

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

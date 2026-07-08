#!/usr/bin/env bash
# Progressive verification pipeline for an agent environment.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# Quick (default): ecosystem smoke + health only
# Full (--full):   + conventional tests, lint, optional readiness + browser-e2e
# Stock steps are examples. Replace them during adaptation to match this repo.
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

node_package_script_exists() {
  local script="$1"
  "${NODE_BIN:-node}" -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const script = process.argv[1];
process.exit(pkg.scripts && pkg.scripts[script] ? 0 : 1);
" "$script"
}

run_node_script_or_skip() {
  local name="$1"
  local script="$2"
  if node_package_script_exists "$script"; then
    run_step "$name" "${NPM_BIN:-npm} run ${script}"
  else
    run_step "$name" "echo 'No ${script} script configured; skipping.'"
  fi
}

run_node_quick_smoke() {
  if node_package_script_exists typecheck; then
    run_step "node-typecheck" '${NPM_BIN:-npm} run typecheck'
  elif node_package_script_exists build; then
    run_step "node-build" '${NPM_BIN:-npm} run build'
  else
    run_step "node-package-load" '${NODE_BIN:-node} -e "require(\"./package.json\")"'
  fi
}

run_quick_smoke() {
  case "${HARNESS_ECOSYSTEM:-none}" in
    node)
      run_node_quick_smoke
      ;;
    python)
      run_step "python-compile" '${PYTHON_BIN:-python3} -m compileall -q .'
      ;;
    go)
      run_step "go-build" '${GO_BIN:-go} build ./...'
      ;;
    rust)
      run_step "rust-check" '${CARGO_BIN:-cargo} check'
      ;;
    java)
      run_step "java-compile" 'if [ -x ./mvnw ]; then ./mvnw -q -DskipTests compile; elif command -v mvn >/dev/null 2>&1; then mvn -q -DskipTests compile; elif [ -x ./gradlew ]; then ./gradlew classes; elif command -v gradle >/dev/null 2>&1; then gradle classes; else echo "No Maven/Gradle command found; adapt verify.sh for this Java repo."; fi'
      ;;
    ruby)
      run_step "ruby-smoke" '${RUBY_BIN:-ruby} -e "puts RUBY_VERSION"'
      ;;
    custom|none|*)
      run_step "smoke-not-configured" 'echo "No stock smoke for HARNESS_ECOSYSTEM=${HARNESS_ECOSYSTEM:-none}; adapt .har/verify.sh for this repo."'
      ;;
  esac
}

run_full_checks() {
  case "${HARNESS_ECOSYSTEM:-none}" in
    node)
      run_node_script_or_skip "unit-tests" test || true
      run_node_script_or_skip "lint" lint || true
      ;;
    python)
      run_step "unit-tests" 'if ${PYTHON_BIN:-python3} -c "import pytest" >/dev/null 2>&1; then ${PYTHON_BIN:-python3} -m pytest -q; else echo "pytest not installed; adapt verify.sh for this Python repo."; fi' || true
      ;;
    go)
      run_step "unit-tests" '${GO_BIN:-go} test ./...' || true
      ;;
    rust)
      run_step "unit-tests" '${CARGO_BIN:-cargo} test' || true
      ;;
    java)
      run_step "unit-tests" 'if [ -x ./mvnw ]; then ./mvnw -q test; elif command -v mvn >/dev/null 2>&1; then mvn -q test; elif [ -x ./gradlew ]; then ./gradlew test; elif command -v gradle >/dev/null 2>&1; then gradle test; else echo "No Maven/Gradle command found; adapt verify.sh for this Java repo."; fi' || true
      ;;
    ruby)
      run_step "unit-tests" 'if command -v "${BUNDLE_BIN:-bundle}" >/dev/null 2>&1 && [ -f Gemfile ]; then "${BUNDLE_BIN:-bundle}" exec rake test 2>/dev/null || "${BUNDLE_BIN:-bundle}" exec rspec; else echo "No Ruby test command detected; adapt verify.sh for this Ruby repo."; fi' || true
      ;;
    custom|none|*)
      run_step "unit-tests" 'echo "No stock full checks for HARNESS_ECOSYSTEM=${HARNESS_ECOSYSTEM:-none}; adapt .har/verify.sh for this repo."' || true
      ;;
  esac
}

# ── Verification stages ─────────────────────────────────────────────────────
# These stock steps are intentionally generic conventions. Adapt this section
# to the repository's real commands from package.json, Makefile, CI, pyproject,
# Cargo.toml, go.mod, pom.xml, etc.
run_quick_smoke || { [ -z "$FULL" ] && true; }
run_http_step "api-health" "http://localhost:${API_PORT}${HARNESS_HEALTH_CHECK_PATH}" || { [ -z "$FULL" ] && true; }

if [ -n "$FULL" ]; then
  run_full_checks
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

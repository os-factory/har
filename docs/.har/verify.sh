#!/usr/bin/env bash
# Progressive verification for the Astro docs / marketing site.
# Outputs JSON to stdout (machine contract), human-readable progress to stderr.
# Passing steps omit `output`. `har env verify` streams progress only.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# Quick (default): astro check + site health
# Full (--full):   + drift, build, links, readiness, browser-e2e (screenshots)
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

WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE")"
FE_PORT="${FE_PORT:-$(( HARNESS_FE_BASE_PORT + AGENT_ID * ${HARNESS_PORT_STEP:-10} ))}"
API_PORT="${API_PORT:-$FE_PORT}"

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

  local pass_bool
  if [ "$exit_code" = "0" ]; then
    echo "✓ (${elapsed}ms)" >&2
    pass_bool="true"
  else
    echo "✗ (${elapsed}ms)" >&2
    echo "$output" | head -30 | sed 's/^/    /' >&2
    pass_bool="false"
    OVERALL_PASS=false
  fi

  record_step_result "$name" "$pass_bool" "$elapsed" "$output"

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

  local pass_bool
  if [ "$exit_code" = "0" ]; then
    echo "✓ (${elapsed}ms)" >&2
    pass_bool="true"
  else
    echo "✗ (${elapsed}ms)" >&2
    pass_bool="false"
    OVERALL_PASS=false
  fi

  record_step_result "$name" "$pass_bool" "$elapsed" "$output"

  if [ "$pass_bool" = "false" ] && [ -z "$FULL" ]; then
    return 1
  fi
}

# ── Verification stages ─────────────────────────────────────────────────────
# Quick: type/content check + live site. Full: contract drift, production build,
# link check, readiness smoke, Playwright (+ screenshot artifacts).

run_step "check" '${NPM_BIN:-npm} run check' || { [ -z "$FULL" ] && true; }
run_http_step "site-health" "http://localhost:${FE_PORT}${HARNESS_HEALTH_CHECK_PATH}" || { [ -z "$FULL" ] && true; }

if [ -n "$FULL" ]; then
  run_step "drift" '${NPM_BIN:-npm} run drift' || true
  run_step "build" '${NPM_BIN:-npm} run build' || true
  run_step "links" 'if command -v lychee >/dev/null 2>&1; then ${NPM_BIN:-npm} run links; else echo "lychee not on PATH; skipping links (CI installs it via docs.yml)."; fi' || true
  run_step "readiness" "run_readiness_if_configured \"$AGENT_ID\"" || true
  while IFS=$'\t' read -r STAGE_ID STAGE_CMD; do
    [ -n "$STAGE_ID" ] || continue
    run_step "$STAGE_ID" "$STAGE_CMD" || true
  done < <(list_registered_verification_stage_commands "$SCRIPT_DIR" "$AGENT_ID")
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

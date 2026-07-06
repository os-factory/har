#!/usr/bin/env bash
# Verification pipeline for iOS mobile app repos — build and test with xcodebuild.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# Quick (default): build + unit-tests
# Full (--full):   + lint (SwiftLint) + rocketsim-flows (if installed)
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
  echo "No .env.agent.${AGENT_ID} found. Run: ./.har/launch.sh ${AGENT_ID}" >&2
  exit 1
}

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE")"

echo "==> Verifying agent ${AGENT_ID} in ${WORK_DIR}..." >&2

# Build xcodebuild project/workspace flags
xc_target_flags() {
  if [ -n "${HARNESS_XCODE_WORKSPACE:-}" ] && [ -e "$WORK_DIR/${HARNESS_XCODE_WORKSPACE}" ]; then
    echo "-workspace $WORK_DIR/${HARNESS_XCODE_WORKSPACE}"
  elif [ -n "${HARNESS_XCODE_PROJECT:-}" ] && [ -e "$WORK_DIR/${HARNESS_XCODE_PROJECT}" ]; then
    echo "-project $WORK_DIR/${HARNESS_XCODE_PROJECT}"
  else
    # Auto-detect: prefer workspace (CocoaPods), then project
    local ws prj
    ws="$(find "$WORK_DIR" -maxdepth 2 -name "*.xcworkspace" ! -path "*/\.*" 2>/dev/null | head -1 || true)"
    prj="$(find "$WORK_DIR" -maxdepth 2 -name "*.xcodeproj" ! -path "*/\.*" 2>/dev/null | head -1 || true)"
    if [ -n "$ws" ]; then echo "-workspace $ws"
    elif [ -n "$prj" ]; then echo "-project $prj"
    fi
  fi
}

XC_FLAGS="$(xc_target_flags)"
XC_SCHEME="${HARNESS_XCODE_SCHEME:-MyApp}"
XC_DESTINATION="${HARNESS_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 16}"
XC_DERIVED="${WORK_DIR}/build/DerivedData"

OVERALL_PASS=true
START_TOTAL=$(date +%s%3N 2>/dev/null || echo "0")
RESULTS_JSON="[]"

run_step() {
  local name="$1"
  local cmd="$2"
  local start end elapsed exit_code output

  printf "  → %-40s" "$name..." >&2
  start=$(date +%s%3N 2>/dev/null || echo "0")

  set +e
  output=$(cd "$WORK_DIR" && eval "$cmd" 2>&1)
  exit_code=$?
  set -e

  end=$(date +%s%3N 2>/dev/null || echo "0")
  elapsed=$(( end - start ))

  local pass_bool step_output_escaped
  if [ "$exit_code" = "0" ]; then
    echo "✓ (${elapsed}ms)" >&2
    pass_bool="true"
  else
    echo "✗ (${elapsed}ms)" >&2
    echo "$output" | head -40 | sed 's/^/    /' >&2
    pass_bool="false"
    OVERALL_PASS=false
  fi

  step_output_escaped=$(echo "$output" | head -50 | \
    node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d.trim())))" \
    2>/dev/null || echo '""')

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

# Build (compile-only — catches syntax errors and missing symbols)
run_step "build" "xcodebuild build \
  ${XC_FLAGS} \
  -scheme \"${XC_SCHEME}\" \
  -destination \"${XC_DESTINATION}\" \
  -derivedDataPath \"${XC_DERIVED}\" \
  CODE_SIGNING_ALLOWED=NO \
  | xcbeautify 2>/dev/null || xcodebuild build \
    ${XC_FLAGS} \
    -scheme \"${XC_SCHEME}\" \
    -destination \"${XC_DESTINATION}\" \
    -derivedDataPath \"${XC_DERIVED}\" \
    CODE_SIGNING_ALLOWED=NO" || { [ -z "$FULL" ] && true; }

# Unit tests
run_step "unit-tests" "xcodebuild test \
  ${XC_FLAGS} \
  -scheme \"${XC_SCHEME}\" \
  -destination \"${XC_DESTINATION}\" \
  -derivedDataPath \"${XC_DERIVED}\" \
  CODE_SIGNING_ALLOWED=NO \
  | xcbeautify 2>/dev/null || xcodebuild test \
    ${XC_FLAGS} \
    -scheme \"${XC_SCHEME}\" \
    -destination \"${XC_DESTINATION}\" \
    -derivedDataPath \"${XC_DERIVED}\" \
    CODE_SIGNING_ALLOWED=NO" || { [ -z "$FULL" ] && true; }

if [ -n "$FULL" ]; then
  # SwiftLint — optional, skip gracefully when not installed
  run_step "lint" "command -v \"${HARNESS_SWIFTLINT_CMD:-swiftlint}\" >/dev/null 2>&1 && \
    \"${HARNESS_SWIFTLINT_CMD:-swiftlint}\" --quiet 2>&1 || echo 'swiftlint not installed — skipping'" || true

  # RocketSim user-flow validation — installed via: har env add-stage rocketsim
  run_rocketsim_flows_if_present "$SCRIPT_DIR" "$AGENT_ID" || true
fi

END_TOTAL=$(date +%s%3N 2>/dev/null || echo "0")
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

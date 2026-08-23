#!/usr/bin/env bash
# Verification pipeline for iOS mobile app repos — build and test with xcodebuild.
# Outputs JSON to stdout (machine contract), human-readable progress to stderr.
# Passing steps omit `output`. `har env verify` streams progress only.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# Quick (default): build smoke (compile-only)
# Full (--full):   + unit tests, lint (SwiftLint), and every registered stage
#                  in stages.json verificationStages (see .har/STAGES.md)
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

echo "==> Verifying agent ${AGENT_ID} in ${WORK_DIR}..." >&2
REG_FILE="$(slot_registry_file "$AGENT_ID")"
echo "    Work dir: ${WORK_DIR}" >&2
echo "    Env file: ${ENV_FILE}" >&2
if [ -f "$REG_FILE" ]; then
  echo "    Registry: ${REG_FILE}" >&2
else
  echo "    Registry: missing (${REG_FILE})" >&2
fi

# Build xcodebuild project/workspace flags
xc_target_flags() {
  if [ -n "${HARNESS_XCODE_WORKSPACE:-}" ] && [ -e "$WORK_DIR/${HARNESS_XCODE_WORKSPACE}" ]; then
    echo "-workspace $WORK_DIR/${HARNESS_XCODE_WORKSPACE}"
  elif [ -n "${HARNESS_XCODE_PROJECT:-}" ] && [ -e "$WORK_DIR/${HARNESS_XCODE_PROJECT}" ]; then
    echo "-project $WORK_DIR/${HARNESS_XCODE_PROJECT}"
  else
    # Auto-detect: prefer workspace (CocoaPods), then project. Runs from inside
    # WORK_DIR so a dot in the worktree path itself cannot trip the dotfile
    # filter, and skips both the project.xcworkspace every .xcodeproj carries
    # inside it and the CocoaPods project under Pods/ — either would point
    # xcodebuild at the wrong target.
    local ws prj
    ws="$(cd "$WORK_DIR" && find . -maxdepth 2 -name "*.xcworkspace" \
      ! -path "./.*" ! -path "*.xcodeproj/*" ! -path "*/Pods/*" 2>/dev/null | head -1 || true)"
    prj="$(cd "$WORK_DIR" && find . -maxdepth 2 -name "*.xcodeproj" \
      ! -path "./.*" ! -path "*/Pods/*" 2>/dev/null | head -1 || true)"
    if [ -n "$ws" ]; then echo "-workspace $WORK_DIR/${ws#./}"
    elif [ -n "$prj" ]; then echo "-project $WORK_DIR/${prj#./}"
    fi
  fi
}

XC_FLAGS="$(xc_target_flags)"
XC_SCHEME="${HARNESS_XCODE_SCHEME:-MyApp}"
XC_DESTINATION="${HARNESS_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 16}"
XC_DERIVED="${WORK_DIR}/build/DerivedData"

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
    echo "$output" | head -40 | sed 's/^/    /' >&2
    pass_bool="false"
    OVERALL_PASS=false
  fi

  record_step_result "$name" "$pass_bool" "$elapsed" "$output"

  if [ "$pass_bool" = "false" ] && [ -z "$FULL" ]; then
    return 1
  fi
}

# Quick (default): compile-only — use XCODEBUILD_BIN from .env.agent.<id> (written by launch)
# Nothing is installed or run, so CODE_SIGNING_ALLOWED=NO keeps the smoke build
# from needing a signing identity.
# Emit the results JSON and exit non-zero when any step failed. Quick mode
# calls this at the first failing step (stopping early); the full pipeline
# runs every step and calls it once at the end.
emit_results() {
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
}

run_step "build" '${XCODEBUILD_BIN:-xcodebuild} build \
  ${XC_FLAGS} \
  -scheme "${XC_SCHEME}" \
  -destination "${XC_DESTINATION}" \
  -derivedDataPath "${XC_DERIVED}" \
  CODE_SIGNING_ALLOWED=NO \
  | xcbeautify 2>/dev/null || ${XCODEBUILD_BIN:-xcodebuild} build \
    ${XC_FLAGS} \
    -scheme "${XC_SCHEME}" \
    -destination "${XC_DESTINATION}" \
    -derivedDataPath "${XC_DERIVED}" \
    CODE_SIGNING_ALLOWED=NO' || emit_results

if [ -n "$FULL" ]; then
  # Full: project-specific checks — add/remove/reorder steps for this repo.
  # No CODE_SIGNING_ALLOWED=NO here, unlike the build step: tests install and run
  # the host app on the simulator, and an unsigned app gets no entitlements. Apps
  # using CloudKit, NSUbiquitousKeyValueStore, or push then trap at launch, before
  # the test harness connects — the whole bundle is lost, not one test.
  run_step "unit-tests" '${XCODEBUILD_BIN:-xcodebuild} test \
    ${XC_FLAGS} \
    -scheme "${XC_SCHEME}" \
    -destination "${XC_DESTINATION}" \
    -derivedDataPath "${XC_DERIVED}" \
    | xcbeautify 2>/dev/null || ${XCODEBUILD_BIN:-xcodebuild} test \
      ${XC_FLAGS} \
      -scheme "${XC_SCHEME}" \
      -destination "${XC_DESTINATION}" \
      -derivedDataPath "${XC_DERIVED}"' || true

  # SwiftLint — optional, skip gracefully when not installed
  run_step "lint" "command -v \"${HARNESS_SWIFTLINT_CMD:-swiftlint}\" >/dev/null 2>&1 && \
    \"${HARNESS_SWIFTLINT_CMD:-swiftlint}\" --quiet 2>&1 || echo 'swiftlint not installed — skipping'" || true

  run_step "readiness" "run_readiness_if_configured \"$AGENT_ID\"" || true

  # Registered verification stages from .har/stages.json (see .har/STAGES.md).
  # Every stage listed in verificationStages with a registered script/command
  # runs here -- plugins and custom stages alike.
  while IFS=$'\t' read -r STAGE_ID STAGE_CMD; do
    [ -n "$STAGE_ID" ] || continue
    run_step "$STAGE_ID" "$STAGE_CMD" || true
  done < <(list_registered_verification_stage_commands "$SCRIPT_DIR" "$AGENT_ID")
fi

emit_results

#!/usr/bin/env bash
# Verification pipeline for iOS mobile app repos — build and test with xcodebuild.
# Outputs JSON to stdout (machine contract), human-readable progress to stderr.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# The pipeline is data: .har/stages.json's verificationStages list, in order.
# Quick (default) runs the stages marked tier "quick"; --full runs the whole
# list. Stage commands use the XC_* variables exported below. Customize
# verification by editing stages.json or adding a stage script (see
# .har/STAGES.md) — never by editing this file.
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
export XC_FLAGS
export XC_SCHEME="${HARNESS_XCODE_SCHEME:-MyApp}"
export XC_DESTINATION="${HARNESS_IOS_DESTINATION:-platform=iOS Simulator,name=${HARNESS_SIMULATOR_NAME:-iPhone 16}}"
export XC_DERIVED="${WORK_DIR}/build/DerivedData"

export HAR_HARNESS_DIR="$SCRIPT_DIR"
export WORK_DIR
exec node "$SCRIPT_DIR/lib/verify-runner.mjs" --agent "$AGENT_ID" ${FULL:+--full}

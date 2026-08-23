#!/usr/bin/env bash
# Verification pipeline for an agent environment.
# Outputs JSON to stdout (machine contract), human-readable progress to stderr.
#
# Usage: ./.har/verify.sh <agent-id> [--full]
#
# The pipeline is data: .har/stages.json's verificationStages list, in order.
# Quick (default) runs the stages marked tier "quick"; --full runs the whole
# list. Customize verification by editing stages.json or adding a stage script
# (see .har/STAGES.md) — never by editing this file.
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

export HAR_HARNESS_DIR="$SCRIPT_DIR"
export WORK_DIR API_PORT
exec node "$SCRIPT_DIR/lib/verify-runner.mjs" --agent "$AGENT_ID" ${FULL:+--full}

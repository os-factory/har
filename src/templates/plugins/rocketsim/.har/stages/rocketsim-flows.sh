#!/usr/bin/env bash
# RocketSim user-flow runner for an agent slot.
# Discovers and runs all flow scripts under flows/ (or a specific one from args).
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/rocketsim-flows.sh <agent-id> [flow-name]
#   flow-name (optional): run only flows/<flow-name>.sh instead of all flows
#
# Prerequisite: ./.har/launch.sh <agent-id> AND app installed+running on simulator
# See: ./.har/stages/ROCKETSIM.md for the full authoring guide.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
# agent-slot.sh expects SCRIPT_DIR to be .har/ (slot registry lives there)
SCRIPT_DIR="$HARNESS_DIR"

# shellcheck source=/dev/null
source "$HARNESS_DIR/harness.env"
# shellcheck source=/dev/null
source "$HARNESS_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: rocketsim-flows.sh <agent-id> [flow-name]}"
FLOW_FILTER="${2:-}"

validate_agent_id "$AGENT_ID"

log() { echo "==> [rocketsim agent-$AGENT_ID] $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────────
if ! command -v rocketsim >/dev/null 2>&1; then
  echo "Error: rocketsim CLI not found." >&2
  echo "  Install from RocketSim → Settings → CLI & Agent → Install Command Line Tool" >&2
  echo "  Then re-run: ./.har/stages/rocketsim-flows.sh ${AGENT_ID}" >&2
  exit 1
fi

# Check RocketSim + Simulator health
if ! rocketsim doctor --quiet 2>/dev/null; then
  log "Warning: rocketsim doctor reported issues — flows may be unreliable."
  log "  Run 'rocketsim doctor' for details."
fi

# ── Resolve agent env ─────────────────────────────────────────────────────────
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

# ── Discover flows ─────────────────────────────────────────────────────────────
FLOWS_DIR="$WORK_DIR/flows"

if [ ! -d "$FLOWS_DIR" ]; then
  echo "Warning: flows/ directory not found in $WORK_DIR" >&2
  echo "  Create flow scripts under flows/ — see .har/stages/ROCKETSIM.md" >&2
  node -e "process.stdout.write(JSON.stringify({
    status: 'pass',
    stageId: 'rocketsim-flows',
    kind: 'test',
    agent_id: ${AGENT_ID},
    total_ms: 0,
    flows: [],
    message: 'No flows directory — nothing to run'
  }, null, 2) + '\n');"
  exit 0
fi

if [ -n "$FLOW_FILTER" ]; then
  FLOW_SCRIPTS=("$FLOWS_DIR/${FLOW_FILTER%.sh}.sh")
  if [ ! -f "${FLOW_SCRIPTS[0]}" ]; then
    echo "Error: flow not found: flows/${FLOW_FILTER%.sh}.sh" >&2
    exit 1
  fi
else
  # while-read instead of mapfile: stock macOS bash is 3.2, which lacks mapfile.
  FLOW_SCRIPTS=()
  while IFS= read -r flow_script; do
    FLOW_SCRIPTS+=("$flow_script")
  done < <(find "$FLOWS_DIR" -maxdepth 1 -name "*.sh" ! -name ".*" | sort)
fi

if [ ${#FLOW_SCRIPTS[@]} -eq 0 ]; then
  log "No flow scripts found in flows/ — add .sh files to define user flows."
  node -e "process.stdout.write(JSON.stringify({
    status: 'pass',
    stageId: 'rocketsim-flows',
    kind: 'test',
    agent_id: ${AGENT_ID},
    total_ms: 0,
    flows: [],
    message: 'No flows defined yet'
  }, null, 2) + '\n');"
  exit 0
fi

# ── Artifact directory ────────────────────────────────────────────────────────
ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/rocketsim-flows"
mkdir -p "$ARTIFACT_DIR"

# ── Run flows ─────────────────────────────────────────────────────────────────
log "Running ${#FLOW_SCRIPTS[@]} flow(s) against simulator..."

OVERALL_PASS=true
START_TOTAL=$(now_ms)
FLOW_RESULTS="[]"

for FLOW_SCRIPT in "${FLOW_SCRIPTS[@]}"; do
  FLOW_NAME="$(basename "$FLOW_SCRIPT" .sh)"
  printf "  → %-40s" "$FLOW_NAME..." >&2

  FLOW_ARTIFACT_DIR="$ARTIFACT_DIR/$FLOW_NAME"
  mkdir -p "$FLOW_ARTIFACT_DIR"

  FLOW_START=$(now_ms)

  set +e
  FLOW_OUTPUT=$(
    HARNESS_DIR="$HARNESS_DIR" \
    WORK_DIR="$WORK_DIR" \
    AGENT_ID="$AGENT_ID" \
    FLOW_ARTIFACT_DIR="$FLOW_ARTIFACT_DIR" \
    HARNESS_BUNDLE_ID="${HARNESS_BUNDLE_ID:-}" \
    HARNESS_SIMULATOR_NAME="${HARNESS_SIMULATOR_NAME:-}" \
    bash "$FLOW_SCRIPT" 2>&1
  )
  FLOW_EXIT=$?
  set -e

  FLOW_END=$(now_ms)
  FLOW_MS=$(( FLOW_END - FLOW_START ))

  if [ "$FLOW_EXIT" = "0" ]; then
    echo "✓ (${FLOW_MS}ms)" >&2
    FLOW_PASS="true"
  else
    echo "✗ (${FLOW_MS}ms)" >&2
    echo "$FLOW_OUTPUT" | head -20 | sed 's/^/    /' >&2
    FLOW_PASS="false"
    OVERALL_PASS=false
  fi

  # Save flow output to artifact
  echo "$FLOW_OUTPUT" > "$FLOW_ARTIFACT_DIR/output.log"

  FLOW_OUTPUT_ESC=$(echo "$FLOW_OUTPUT" | head -30 | \
    node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d.trim())))" \
    2>/dev/null || echo '""')

  FLOW_RESULTS=$(echo "$FLOW_RESULTS" | node -e "
const fs = require('fs');
let arr = JSON.parse(fs.readFileSync('/dev/stdin','utf8'));
arr.push({
  name: '$FLOW_NAME',
  pass: $FLOW_PASS,
  ms: $FLOW_MS,
  output: $FLOW_OUTPUT_ESC,
  artifacts: '$FLOW_ARTIFACT_DIR'
});
process.stdout.write(JSON.stringify(arr));
" 2>/dev/null || echo "$FLOW_RESULTS")
done

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

# ── Output ────────────────────────────────────────────────────────────────────
node -e "
const flows = $FLOW_RESULTS;
const overall = flows.length > 0 && flows.every(f => f.pass);
const out = {
  status: overall ? 'pass' : 'fail',
  stageId: 'rocketsim-flows',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $TOTAL_MS,
  flows,
  artifacts: [
    { path: '.har/artifacts/rocketsim-flows', kind: 'directory' }
  ]
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

if [ "$OVERALL_PASS" = "false" ]; then
  exit 1
fi

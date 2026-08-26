#!/usr/bin/env bash
# Semgrep SAST scan for an agent slot.
# Scans the session worktree with Semgrep and writes JSON + SARIF reports.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/sast.sh <agent-id> [paths...]
#   paths (optional): scan only these paths instead of the whole worktree
#
# Config: HARNESS_SEMGREP_CONFIG (default "auto") — any semgrep --config value,
#   e.g. "p/ci", "p/security-audit", or a local rules file/dir. Set it in
#   .har/harness.env to pin rulesets. Registry configs (auto, p/...) need
#   network access and send pseudonymized metrics to semgrep.dev.
#
# Prerequisite: ./.har/launch.sh <agent-id> AND the semgrep CLI installed
# See: ./.har/stages/SEMGREP.md for the full adaptation guide.
set -euo pipefail

# 1.0 stage surface: the runner exports WORK_DIR, ENV_FILE, AGENT_ID and
# HAR_HARNESS_DIR, with harness.env and the slot env file already sourced —
# agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

AGENT_ID="${1:-${AGENT_ID:?Usage: sast.sh <agent-id> [paths...]}}"
[ "$#" -gt 0 ] && shift
SCAN_PATHS=("$@")

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }

log() { echo "==> [semgrep agent-$AGENT_ID] $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────────
if ! command -v semgrep >/dev/null 2>&1; then
  echo "Error: semgrep CLI not found." >&2
  echo "  Install with one of:" >&2
  echo "    pipx install semgrep      # recommended" >&2
  echo "    pip install semgrep" >&2
  echo "    brew install semgrep      # may lag behind the latest release" >&2
  echo "  Then re-run: ./.har/stages/sast.sh ${AGENT_ID}" >&2
  exit 1
fi

# ── Resolve agent env ─────────────────────────────────────────────────────────
# Artifacts land in the main repo root (where .har/ lives), not the worktree.
MAIN_REPO_ROOT="$REPO_ROOT"

ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run ./.har/launch.sh ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run ./.har/launch.sh ${AGENT_ID} first}"

# ── Artifact directory (main repo root, not the worktree) ─────────────────────
ARTIFACT_DIR="$MAIN_REPO_ROOT/.har/artifacts/sast"
mkdir -p "$ARTIFACT_DIR"

SEMGREP_CONFIG="${HARNESS_SEMGREP_CONFIG:-auto}"
JSON_REPORT="$ARTIFACT_DIR/semgrep.json"
SARIF_REPORT="$ARTIFACT_DIR/semgrep.sarif"
SCAN_LOG="$ARTIFACT_DIR/scan.log"

# ── Run semgrep ───────────────────────────────────────────────────────────────
log "Scanning $WORK_DIR (config: $SEMGREP_CONFIG)..."
START=$(now_ms)

set +e
(
  cd "$WORK_DIR" &&
  semgrep scan \
    --config "$SEMGREP_CONFIG" \
    --error \
    --exclude .har \
    --json-output "$JSON_REPORT" \
    --sarif-output "$SARIF_REPORT" \
    ${SCAN_PATHS[@]+"${SCAN_PATHS[@]}"}
) >"$SCAN_LOG" 2>&1
SEMGREP_EXIT=$?
set -e

END=$(now_ms)
TOTAL_MS=$(( END - START ))

# Surface the scan tail so failures are diagnosable without opening the log
tail -20 "$SCAN_LOG" | sed 's/^/    /' >&2

# semgrep exit codes: 0 = clean, 1 = findings (--error), >=2 = scan error
if [ "$SEMGREP_EXIT" = "0" ]; then
  STATUS="pass"
  log "✓ No blocking findings (${TOTAL_MS}ms)"
elif [ "$SEMGREP_EXIT" = "1" ]; then
  STATUS="fail"
  log "✗ Semgrep reported findings (${TOTAL_MS}ms) — see $JSON_REPORT"
else
  STATUS="fail"
  log "✗ Semgrep scan errored with exit code $SEMGREP_EXIT (${TOTAL_MS}ms) — see $SCAN_LOG"
fi

# ── Output ────────────────────────────────────────────────────────────────────
node -e "
const fs = require('fs');
let findings = null;
let errors = null;
try {
  const report = JSON.parse(fs.readFileSync('$JSON_REPORT', 'utf8'));
  findings = report.results ? report.results.length : 0;
  errors = report.errors ? report.errors.length : 0;
} catch { /* report missing when the scan itself errored */ }
const out = {
  status: '$STATUS',
  stageId: 'sast',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $TOTAL_MS,
  exit_code: $SEMGREP_EXIT,
  config: '$SEMGREP_CONFIG',
  findings,
  scan_errors: errors,
  artifacts: [
    { path: '.har/artifacts/sast', kind: 'directory' },
    { path: '.har/artifacts/sast/semgrep.json', kind: 'report' }
  ]
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

if [ "$SEMGREP_EXIT" != "0" ]; then
  exit "$SEMGREP_EXIT"
fi

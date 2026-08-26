#!/usr/bin/env bash
# Gitleaks secrets scan for an agent slot.
# Scans the agent work dir for hardcoded secrets and writes a redacted JSON report.
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/secrets-scan.sh <agent-id> [mode]
#   mode (optional): dir (default) — scan the working tree, incl. uncommitted files
#                    git           — scan the full git history of the worktree
#
# Prerequisite: gitleaks on PATH (brew install gitleaks, or a release binary
# from https://github.com/gitleaks/gitleaks/releases)
# See: ./.har/stages/GITLEAKS.md for the adaptation guide.
set -euo pipefail

# 1.0 stage surface: the runner exports WORK_DIR, ENV_FILE, AGENT_ID and
# HAR_HARNESS_DIR, with harness.env and the slot env file already sourced —
# agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

AGENT_ID="${1:-${AGENT_ID:?Usage: secrets-scan.sh <agent-id> [dir|git]}}"
MODE="${2:-dir}"

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }

if [ "$MODE" != "dir" ] && [ "$MODE" != "git" ]; then
  echo "Error: unknown mode '$MODE' — expected 'dir' or 'git'." >&2
  exit 1
fi

log() { echo "==> [secrets-scan agent-$AGENT_ID] $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────────
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "Error: gitleaks not found on PATH." >&2
  echo "  Install: brew install gitleaks" >&2
  echo "  Or download a release binary: https://github.com/gitleaks/gitleaks/releases" >&2
  echo "  Then re-run: ./.har/stages/secrets-scan.sh ${AGENT_ID}" >&2
  exit 1
fi

# ── Artifact directory ────────────────────────────────────────────────────────
# Resolved BEFORE sourcing .env.agent.<id>, which overrides REPO_ROOT with the
# worktree path — artifacts must land in the main repo root per convention.
ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/secrets-scan"
mkdir -p "$ARTIFACT_DIR"
REPORT_PATH="$ARTIFACT_DIR/report.json"
SCAN_LOG="$ARTIFACT_DIR/gitleaks.log"

# ── Resolve agent env ─────────────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run ./.har/launch.sh ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run ./.har/launch.sh ${AGENT_ID} first}"

GITLEAKS_VERSION="$(gitleaks version 2>/dev/null | head -1 || echo unknown)"
log "gitleaks ${GITLEAKS_VERSION} — ${MODE} scan of $WORK_DIR"

# ── Scan ──────────────────────────────────────────────────────────────────────
# --exit-code 99 distinguishes "leaks found" (99) from tool errors (other non-zero).
# --redact keeps discovered secret values out of the report artifact.
START=$(now_ms)

set +e
gitleaks "$MODE" "$WORK_DIR" \
  --report-format json \
  --report-path "$REPORT_PATH" \
  --exit-code 99 \
  --redact \
  --no-banner \
  >"$SCAN_LOG" 2>&1
SCAN_EXIT=$?
set -e

END=$(now_ms)
TOTAL_MS=$(( END - START ))

if [ "$SCAN_EXIT" != "0" ] && [ "$SCAN_EXIT" != "99" ]; then
  log "gitleaks failed (exit $SCAN_EXIT) — last log lines:"
  tail -20 "$SCAN_LOG" | sed 's/^/    /' >&2
fi

if [ "$SCAN_EXIT" = "99" ]; then
  log "Leaks detected — see $REPORT_PATH (redacted)"
else
  log "Scan finished in ${TOTAL_MS}ms (exit $SCAN_EXIT)"
fi

# ── Output ────────────────────────────────────────────────────────────────────
REPORT_PATH="$REPORT_PATH" SCAN_EXIT="$SCAN_EXIT" TOTAL_MS="$TOTAL_MS" \
AGENT_ID="$AGENT_ID" MODE="$MODE" node -e "
const fs = require('fs');
const scanExit = Number(process.env.SCAN_EXIT);
let leaks = [];
try {
  leaks = JSON.parse(fs.readFileSync(process.env.REPORT_PATH, 'utf8')) || [];
} catch { /* no report written (older gitleaks writes none on a clean scan) */ }
const status = scanExit === 0 ? 'pass' : 'fail';
const out = {
  status,
  stageId: 'secrets-scan',
  kind: 'test',
  agent_id: Number(process.env.AGENT_ID),
  total_ms: Number(process.env.TOTAL_MS),
  mode: process.env.MODE,
  leaks_found: leaks.length,
  findings: leaks.slice(0, 20).map((l) => ({
    rule: l.RuleID,
    file: l.File,
    line: l.StartLine,
    commit: l.Commit || undefined,
  })),
  error: scanExit !== 0 && scanExit !== 99 ? 'gitleaks exited ' + scanExit + ' — see .har/artifacts/secrets-scan/gitleaks.log' : undefined,
  artifacts: [
    { path: '.har/artifacts/secrets-scan', kind: 'directory' }
  ]
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

if [ "$SCAN_EXIT" = "99" ]; then
  exit 1
fi
exit "$SCAN_EXIT"

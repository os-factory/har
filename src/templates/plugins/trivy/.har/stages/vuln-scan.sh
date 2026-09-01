#!/usr/bin/env bash
# Trivy vulnerability + misconfiguration scan for an agent slot.
# Scans the agent's worktree filesystem: dependency lockfiles (vuln) and
# IaC/config files — Terraform, Dockerfile, Kubernetes, CloudFormation (misconfig).
# Outputs JSON to stdout, human-readable progress to stderr.
#
# Usage: ./.har/stages/vuln-scan.sh <agent-id>
#
# Tune via harness.env or the environment:
#   HARNESS_TRIVY_SEVERITY  fail threshold (default: HIGH,CRITICAL)
#   HARNESS_TRIVY_SCANNERS  scanners to run (default: vuln,misconfig)
#   TRIVY_CACHE_DIR         vulnerability DB cache (default: ~/.cache/trivy —
#                           shared across slots so the DB downloads once)
#
# Prerequisite: har env launch <agent-id>
# See: ./.har/stages/TRIVY.md for the full adaptation guide.
set -euo pipefail

# 1.0 stage surface: the runner exports WORK_DIR, ENV_FILE, AGENT_ID and
# HAR_HARNESS_DIR, with harness.env and the slot env file already sourced —
# agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

AGENT_ID="${1:-${AGENT_ID:?Usage: vuln-scan.sh <agent-id>}}"

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }

log() { echo "==> [vuln-scan agent-$AGENT_ID] $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────────
if ! command -v trivy >/dev/null 2>&1; then
  echo "Error: trivy CLI not found." >&2
  echo "  Install: https://trivy.dev/latest/getting-started/installation/" >&2
  echo "    macOS:  brew install trivy" >&2
  echo "    Linux:  curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b ~/.local/bin" >&2
  echo "  Then re-run: ./.har/stages/vuln-scan.sh ${AGENT_ID}" >&2
  exit 1
fi

# ── Resolve agent env ─────────────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"

# ── Configuration ─────────────────────────────────────────────────────────────
SEVERITY="${HARNESS_TRIVY_SEVERITY:-HIGH,CRITICAL}"
SCANNERS="${HARNESS_TRIVY_SCANNERS:-vuln,misconfig}"
# One shared DB cache for every slot/worktree — first run downloads ~60MB,
# subsequent runs reuse it.
export TRIVY_CACHE_DIR="${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}"

# ── Artifact directory ────────────────────────────────────────────────────────
ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/vuln-scan"
mkdir -p "$ARTIFACT_DIR"
REPORT_JSON="$ARTIFACT_DIR/report.json"

# ── Scan ──────────────────────────────────────────────────────────────────────
# Use the WORKTREE's .trivyignore (not the main checkout's) so suppressions are
# reviewed with the code change that introduces them.
IGNOREFILE_ARGS=()
if [ -f "$WORK_DIR/.trivyignore" ]; then
  IGNOREFILE_ARGS=(--ignorefile "$WORK_DIR/.trivyignore")
fi

log "Scanning $WORK_DIR (scanners: $SCANNERS, fail on: $SEVERITY)..."
START=$(now_ms)

set +e
trivy fs \
  --scanners "$SCANNERS" \
  --severity "$SEVERITY" \
  --exit-code 1 \
  --format json \
  --output "$REPORT_JSON" \
  --no-progress \
  ${IGNOREFILE_ARGS[@]+"${IGNOREFILE_ARGS[@]}"} \
  "$WORK_DIR" 2> >(sed 's/^/  /' >&2)
TRIVY_EXIT=$?
set -e

END=$(now_ms)
TOTAL_MS=$(( END - START ))

if [ ! -f "$REPORT_JSON" ]; then
  echo "Error: trivy did not produce a report (exit $TRIVY_EXIT) — see stderr above." >&2
  exit "$TRIVY_EXIT"
fi

# Human-readable summary next to the JSON report (best effort)
trivy convert --format table "$REPORT_JSON" > "$ARTIFACT_DIR/summary.txt" 2>/dev/null || true

# ── Output ────────────────────────────────────────────────────────────────────
STATUS="pass"
if [ "$TRIVY_EXIT" -ne 0 ]; then
  STATUS="fail"
fi

node -e "
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('$REPORT_JSON', 'utf8'));
const results = report.Results || [];
let vulnerabilities = 0;
let misconfigurations = 0;
let secrets = 0;
const findings = [];
for (const r of results) {
  for (const v of r.Vulnerabilities || []) {
    vulnerabilities++;
    findings.push({ type: 'vuln', target: r.Target, id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || null, severity: v.Severity, title: (v.Title || '').slice(0, 120) });
  }
  for (const m of r.Misconfigurations || []) {
    misconfigurations++;
    findings.push({ type: 'misconfig', target: r.Target, id: m.ID, severity: m.Severity, title: (m.Title || '').slice(0, 120) });
  }
  for (const s of r.Secrets || []) {
    secrets++;
    findings.push({ type: 'secret', target: r.Target, id: s.RuleID, severity: s.Severity, title: (s.Title || '').slice(0, 120) });
  }
}
const out = {
  status: '$STATUS',
  stageId: 'vuln-scan',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $TOTAL_MS,
  severity_threshold: '$SEVERITY',
  scanners: '$SCANNERS',
  counts: { vulnerabilities, misconfigurations, secrets },
  findings: findings.slice(0, 50),
  artifacts: [
    { path: '.har/artifacts/vuln-scan/report.json', kind: 'report' },
    { path: '.har/artifacts/vuln-scan/summary.txt', kind: 'report' }
  ]
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

if [ "$STATUS" = "fail" ]; then
  log "✗ Findings at or above $SEVERITY — see .har/artifacts/vuln-scan/summary.txt"
  exit 1
fi
log "✓ No findings at or above $SEVERITY (${TOTAL_MS}ms)"

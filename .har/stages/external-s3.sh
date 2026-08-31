#!/usr/bin/env bash
# external-s3 — a real external worktree, end to end, plus the owned path
#
# Station S3 of the external-worktree factory line (#253).
# Drives the BUILT CLI through the full lifecycle inside a worktree created
# outside HAR (the artifact a tool like Warp or Conductor produces), then does
# the same for a HAR-owned slot so the ordinary path is proven unchanged.
#
# Registered in stages.json; deliberately ABSENT from verificationStages —
# run it with: har line gate S3 --line external-worktree
set -uo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
COMMON="$(dirname "${BASH_SOURCE[0]}")/external-common.sh"
[ -f "$COMMON" ] || COMMON="$HARNESS_DIR/lines/external-worktree/stages/external-common.sh"
. "$COMMON"

TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/external-s3"
mkdir -p "$ARTIFACTS_DIR"
REPORT="$ARTIFACTS_DIR/lab.log"

echo "==> [external-s3 agent-${AGENT_ID}] real external worktree, end to end" >&2
echo "==> target: $TARGET" >&2
START=$(now_ms)

# The station tests the CLI as shipped, so it needs a build of the target tree.
if [ ! -f "$TARGET/dist/index.js" ]; then
  (cd "$TARGET" && npm run build >/dev/null 2>&1) || true
fi
HAR_BIN="$TARGET/dist/index.js"

run_lab() {
  HAR="node $HAR_BIN"
  BASE=$(mktemp -d /tmp/har-lab-XXXXXX)
  PASS=0; FAIL=0
  ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
  bad()  { echo "  ✗ $1"; echo "      expected: $2"; echo "      actual:   $3"; FAIL=$((FAIL+1)); }
  check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
  
  g() { git -c user.email=h@e.com -c user.name=h -c commit.gpgsign=false "$@"; }
  jqf() { node -e "const d=require('$1');process.stdout.write(String(d$2 ?? ''))" 2>/dev/null || echo ""; }
  
  echo "== setup: repo + har harness =="
  REPO="$BASE/repo"; mkdir -p "$REPO"; cd "$REPO"
  g init -q -b main; g commit -qm init --allow-empty
  timeout 120 $HAR env init --profile cli --yes </dev/null >/dev/null 2>&1
  g add -A; g commit -qm "add har" >/dev/null
  
  # A tool like Warp creates a linked worktree in its own layout; the path
  # convention is irrelevant — detection compares git-dir against git-common-dir.
  WS="$BASE/.warp/worktrees/feature-x"
  mkdir -p "$(dirname "$WS")"
  g worktree add -q -b feature-x "$WS"
  echo "   external workspace: $WS"
  
  echo
  echo "== S0: HAR knows it does not own the checkout (#254) =="
  cd "$WS" && timeout 240 $HAR env launch 1 --no-worktree --work-id demo --work-source warp </dev/null >/dev/null 2>&1
  REG="$WS/.har/slots/agent-1.json"
  check "registry mode is external"        "external" "$(jqf "$REG" ".mode")"
  check "worktreePath is the workspace"    "$WS"      "$(jqf "$REG" ".worktreePath")"
  SUF=$(jqf "$REG" ".suffix"); check "suffix names the base commit (7 hex)" "7" "${#SUF}"
  STATUS_OUT=$(cd "$WS" && timeout 60 $HAR env status </dev/null 2>&1)
  echo "$STATUS_OUT" | grep -q "externally owned" \
    && ok "status reports external ownership" \
    || bad "status reports external ownership" "externally owned" "$(echo "$STATUS_OUT" | head -6)"
  
  echo
  echo "== S1: evidence lands in the workspace, not the main checkout (#255) =="
  (cd "$WS" && timeout 240 $HAR env verify 1 </dev/null >/dev/null 2>&1)
  WS_RUNS=$(find "$WS/.har/runs" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  MAIN_RUNS=$(find "$REPO/.har/runs" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  [ "$WS_RUNS" -gt 0 ] && ok "run records written in the workspace ($WS_RUNS)" \
    || bad "run records written in the workspace" ">0" "$WS_RUNS"
  check "main checkout has no runs from this session" "0" "$MAIN_RUNS"
  WU=$(grep -rl '"workUnitId": *"demo"' "$WS/.har/work-units" 2>/dev/null | head -1)
  [ -n "$WU" ] && ok "work unit 'demo' bound in the workspace" \
    || bad "work unit 'demo' bound in the workspace" "a record" "$(ls "$WS/.har/work-units" 2>/dev/null | head -3)"
  MAIN_WU=$(grep -rl '"workUnitId": *"demo"' "$REPO/.har/work-units" 2>/dev/null | head -1)
  [ -z "$MAIN_WU" ] && ok "main checkout does not hold the workspace work unit" \
    || bad "main checkout does not hold the workspace work unit" "absent" "$MAIN_WU"
  
  echo
  echo "== S2: teardown never removes a checkout HAR did not create (#254) =="
  echo "precious uncommitted work" > "$WS/UNCOMMITTED.txt"
  TD=$(cd "$WS" && timeout 120 $HAR env teardown 1 </dev/null 2>&1)
  [ -d "$WS" ] && ok "external worktree survives teardown" || bad "external worktree survives teardown" "present" "REMOVED"
  [ -f "$WS/UNCOMMITTED.txt" ] && ok "uncommitted work survives" || bad "uncommitted work survives" "present" "LOST"
  echo "$TD" | grep -q "Kept externally-owned worktree" \
    && ok "teardown says it kept the checkout" \
    || bad "teardown says it kept the checkout" "Kept externally-owned worktree" "$(echo "$TD" | tail -3)"
  
  echo
  echo "== S3 (the other way): a HAR-owned worktree still works end to end =="
  cd "$REPO"
  LAUNCH=$(timeout 240 $HAR env launch 2 </dev/null 2>&1)
  OREG="$REPO/.har/slots/agent-2.json"
  check "registry mode is worktree" "worktree" "$(jqf "$OREG" ".mode")"
  OWNED=$(jqf "$OREG" ".worktreePath")
  [ -n "$OWNED" ] && [ -d "$OWNED" ] && ok "HAR created its own worktree ($(basename "$OWNED"))" \
    || bad "HAR created its own worktree" "a directory" "$OWNED"
  (cd "$REPO" && timeout 240 $HAR env verify 2 </dev/null >/dev/null 2>&1)
  OWNED_RUNS=$(find "$REPO/.har/runs" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  [ "$OWNED_RUNS" -gt 0 ] && ok "owned-slot runs land in the main checkout ($OWNED_RUNS)" \
    || bad "owned-slot runs land in the main checkout" ">0" "$OWNED_RUNS"
  timeout 120 $HAR env teardown 2 </dev/null >/dev/null 2>&1
  [ -d "$OWNED" ] && bad "HAR removes the worktree it created" "removed" "still present" \
    || ok "HAR removes the worktree it created"
  
  echo
  echo "──────────────────────────────────────────"
  echo "pass=$PASS fail=$FAIL"
  rm -rf "$BASE"
  [ "$FAIL" -eq 0 ] || exit 1
}

set +e
OUTPUT=$(run_lab 2>&1)
EXIT_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$REPORT"
echo "$OUTPUT" >&2
END=$(now_ms)
STATUS="fail"; [ "$EXIT_CODE" = "0" ] && STATUS="pass"
emit_result "external-s3" "$STATUS" "$AGENT_ID" "$(( END - START ))" "$(escape_step_output "$OUTPUT")"
exit "$EXIT_CODE"

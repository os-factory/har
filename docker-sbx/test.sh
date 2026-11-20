#!/usr/bin/env bash
# Smoke test for the har sandbox kit: create a `shell` sandbox with the kit on a
# throwaway fixture repo, then drive the agent flow inside it through `sbx exec`:
# init → launch 1 → verify 1 --full → status → teardown 1.
#
# Usage: docker-sbx/test.sh        (needs sbx >= 0.45 and `sbx login`)
#        AGENT=claude docker-sbx/test.sh (Claude runs launch/verify/teardown from a prompt)
#        KEEP=1 docker-sbx/test.sh (leave the sandbox + fixture behind to poke at)
set -uo pipefail

KIT_DIR="$(cd "$(dirname "$0")/har" && pwd)"
command -v sbx >/dev/null || { echo "sbx not found — install Docker Sandboxes (sbx >= 0.45)"; exit 1; }

PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; echo "      expected: $2"; echo "      actual:   $3"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

g() { git -c user.email=h@e.com -c user.name=h -c commit.gpgsign=false "$@"; }
jqf() { node -e "const d=require('$1');process.stdout.write(String(d$2 ?? ''))" 2>/dev/null || echo ""; }

AGENT="${AGENT:-shell}"   # shell: drive har via sbx exec; claude: let the agent drive it
SB="har-kit-test-$$"
# Under $HOME: the sandbox mounts the workspace at the same absolute path.
FIX="$(mktemp -d "$HOME/.har-sbx-fixture-XXXXXX")"
cleanup() {
  [ -n "${KEEP:-}" ] && { echo "KEEP set — sandbox: $SB  fixture: $FIX"; return; }
  sbx rm --force "$SB" >/dev/null 2>&1
  rm -rf "$FIX"
}
trap cleanup EXIT

# Run a command inside the sandbox (cwd = the workspace); exit status is the command's.
x() { sbx exec "$SB" bash -c "$1" </dev/null; }
# Same, asserting exit 0; shows the tail of the output on failure.
run() {
  local out rc
  out=$(x "$2" 2>&1); rc=$?
  [ $rc -eq 0 ] && ok "$1" || bad "$1" "exit 0" "exit $rc: $(echo "$out" | tail -5)"
}

echo "== setup: fixture repo + sandbox with the har kit =="
cd "$FIX"
g init -q -b main
echo 'module.exports = 1;' > index.js
cat > package.json <<'JSON'
{"name":"sbx-fixture","version":"0.0.0","scripts":{"typecheck":"node --check index.js","lint":"node --check index.js","test":"node --test"}}
JSON
g add -A; g commit -qm init
echo "   fixture: $FIX"
if ! sbx --no-input create --name "$SB" "$AGENT" --kit "$KIT_DIR" "$FIX"; then
  echo "sandbox creation failed"; exit 1
fi

echo
echo "== kit: node 24 + har on PATH, telemetry off =="
NODE_V=$(x 'node -v' 2>&1)
case "$NODE_V" in v24.*) ok "node is $NODE_V" ;; *) bad "node is v24" "v24.x" "$NODE_V" ;; esac
run "har --version" 'har --version'
check "HAR_TELEMETRY=0 in the sandbox" "0" "$(x 'echo -n "$HAR_TELEMETRY"' 2>/dev/null)"

echo
echo "== init =="
run "har env init --profile cli" 'har env init --profile cli --yes'
[ -f .har/stages.json ] && [ -f .har/harness.env ] && ok "harness scaffolded in the workspace" \
  || bad "harness scaffolded in the workspace" ".har/stages.json + harness.env" "$(ls .har 2>&1 | head -5)"
# launch branches a worktree from HEAD, so the harness must be committed
# (--no-verify: init installs the commit gate, which has nothing verified yet)
g add -A; g commit -qm "add har" --no-verify

if [ "$AGENT" = shell ]; then
  echo
  echo "== launch 1 =="
  run "har env launch 1" 'har env launch 1'
  REG="$FIX/.har/slots/agent-1.json"
  check "slot 1 registered as a worktree" "worktree" "$(jqf "$REG" ".mode")"
  WT=$(jqf "$REG" ".worktreePath")
  [ -n "$WT" ] && x "test -d '$WT'" && ok "worktree exists inside the sandbox ($(basename "$WT"))" \
    || bad "worktree exists inside the sandbox" "a directory" "$WT"

  echo
  echo "== verify 1 =="
  run "har env verify 1 --full" 'har env verify 1 --full'
  RUNS=$(find "$FIX/.har/runs" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  [ "$RUNS" -gt 0 ] && ok "run records written ($RUNS)" || bad "run records written" ">0" "$RUNS"

  echo
  echo "== status =="
  STATUS_OUT=$(x 'har env status' 2>&1); STATUS_RC=$?
  check "har env status exits 0" "0" "$STATUS_RC"
  echo "$STATUS_OUT" | grep -q "$(basename "$WT")" && ok "status shows the slot's worktree" \
    || bad "status shows the slot's worktree" "$(basename "$WT")" "$(echo "$STATUS_OUT" | head -8)"

  echo
  echo "== teardown 1 =="
  run "har env teardown 1" 'har env teardown 1'
  x "test -d '$WT'" && bad "worktree removed" "removed" "still present" || ok "worktree removed"

else
  # The real thing: the agent gets one prompt on the command line and has to
  # drive the harness itself.
  echo
  echo "== $AGENT: launch → verify → teardown from a prompt =="
  PROMPT="This repo has a HAR harness (.har/). Using the har CLI, run exactly these in order and stop: \`har env launch 1\`, \`har env verify 1 --full\`, \`har env teardown 1\`. Do not edit any files. Reply with each command's exit status."
  OUT=$(sbx run --name "$SB" -- -p "$PROMPT" </dev/null 2>&1); RC=$?
  echo "$OUT" | tail -15 | sed 's/^/    /'
  check "$AGENT exits 0" "0" "$RC"
  runs() { find "$FIX/.har/runs" -name "*_$1_agent-1.json" 2>/dev/null | wc -l | tr -d ' '; }
  for stage in launch verify teardown; do
    [ "$(runs "$stage")" -gt 0 ] && ok "agent ran $stage (run record)" || bad "agent ran $stage" "a run record" "$(ls "$FIX"/.har/runs/* 2>&1 | head -8)"
  done
  check "no worktree left behind" "1" "$(g worktree list | wc -l | tr -d ' ')"
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]

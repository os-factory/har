#!/usr/bin/env bash
# fixture-e2e — v1.0.0 milestone gate: run the freshly built HAR CLI end-to-end
# against a clone of the car-app example repository (Next.js + SQLite, default
# profile, Playwright plugin). Registered in stages.json verificationStages;
# executed by `verify.sh <id> --full`, so CLI/MCP runs land in `.har/runs/` and
# surface in Mission Control.
#
# Opt-in: skipped unless HAR_FIXTURE_E2E=1 so routine full verifies stay fast.
# HAR_FIXTURE_MILESTONE=M0..M5 adds milestone-specific assertions (extend the
# `milestone_asserts` case as each milestone lands — see
# .claude/skills/v1-milestone/SKILL.md).
#
# Usage: ./.har/stages/fixture-e2e.sh <agent-id>
set -euo pipefail

AGENT_ID="${1:-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ "${HAR_FIXTURE_E2E:-}" != "1" ]; then
  echo "fixture-e2e skipped (set HAR_FIXTURE_E2E=1 to run the milestone gate)."
  exit 0
fi

FIXTURE_SRC="${HAR_FIXTURE_SRC:-/home/antoine/Documents/osfactory/examples/car-app}"
FIXTURE_HOME="${HAR_FIXTURE_HOME:-$HOME/.har-fixtures}"
CLONE="$FIXTURE_HOME/car-app"
FRESH="$FIXTURE_HOME/car-app-fresh"
ART_DIR="$REPO_ROOT/.har/artifacts/fixture-e2e"
HAR_CLI="$REPO_ROOT/dist/index.js"
MILESTONE="${HAR_FIXTURE_MILESTONE:-generic}"

mkdir -p "$ART_DIR"
LOG="$ART_DIR/gate-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee "$LOG") 2>&1

fail() { echo "fixture-e2e FAIL: $*" >&2; exit 1; }

[ -f "$HAR_CLI" ] || fail "no built CLI at $HAR_CLI — run 'npm run build' first (quick verify builds it)"
[ -d "$FIXTURE_SRC/.git" ] || fail "fixture source missing or not a git repo: $FIXTURE_SRC"

har() { (cd "$1" && shift && node "$HAR_CLI" "$@"); }

# ── Fixture clones ────────────────────────────────────────────────────────────
# Persistent clones so node_modules survive between gate runs. The source repo
# is NEVER touched; clone remotes are scrubbed so nothing can push (and no
# remote URL — which may embed credentials — is ever printed).
ensure_clone() {
  local dir="$1"
  if [ ! -d "$dir/.git" ]; then
    echo "==> Cloning fixture into $dir"
    mkdir -p "$FIXTURE_HOME"
    git clone --quiet --no-hardlinks "$FIXTURE_SRC" "$dir"
    git -C "$dir" remote set-url origin invalid://scrubbed
    echo "==> Installing fixture dependencies (first run only)"
    (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error)
  else
    echo "==> Refreshing fixture clone $dir"
    git -C "$dir" fetch --quiet "$FIXTURE_SRC" HEAD
    git -C "$dir" reset --hard --quiet FETCH_HEAD
    git -C "$dir" clean -fdq -e node_modules -e .har/state
  fi
}

runs_today() { find "$1/.har/runs" -name '*.json' -newer "$2" 2>/dev/null | wc -l; }

# ── Mode 1: existing harness (backward compat) ───────────────────────────────
# The fixture ships an adapted default-profile harness (PM2, SQLite per-slot DB,
# Playwright browser-e2e stage). Exercise maintain → launch → full verify →
# status → complete against it with the freshly built CLI.
existing_harness_mode() {
  echo "──> Mode 1: existing adapted harness"
  ensure_clone "$CLONE"
  local marker="$ART_DIR/.mode1-start"; touch "$marker"

  har "$CLONE" env cleanup >/dev/null 2>&1 || true
  har "$CLONE" env teardown 1 >/dev/null 2>&1 || true

  echo "==> har env maintain"
  har "$CLONE" env maintain || fail "maintain failed on existing harness"
  [ -f "$CLONE/.har/maintain/drift-report.json" ] || fail "maintain produced no drift report"

  echo "==> har env launch 1"
  har "$CLONE" env launch 1 || fail "launch failed on existing harness"

  echo "==> har env verify 1 --full"
  har "$CLONE" env verify 1 --full || fail "full verify failed on existing harness"

  echo "==> har env status --json"
  har "$CLONE" env status --json > "$ART_DIR/mode1-status.json" || fail "status failed"

  echo "==> har env complete 1 --skip-verify"
  har "$CLONE" env complete 1 --skip-verify || fail "complete failed"

  [ "$(runs_today "$CLONE" "$marker")" -ge 3 ] || fail "expected run records in clone .har/runs/ (launch/verify/complete)"
  find "$CLONE/.har/validations" -name '*.json' -newer "$marker" | grep -q . \
    || fail "full verify wrote no validation record"
  echo "✓ Mode 1 passed (run + validation records present)"
}

# ── Mode 2: fresh init (generator) ───────────────────────────────────────────
# Wipe .har/ in a second clone and scaffold from scratch, then launch/teardown.
# Full verify quality is covered by Mode 1; this mode proves the generator and
# slot lifecycle on an unadapted harness.
fresh_init_mode() {
  echo "──> Mode 2: fresh har env init"
  ensure_clone "$FRESH"
  rm -rf "$FRESH/.har"

  echo "==> har env init --yes --profile default"
  har "$FRESH" env init --yes --profile default || fail "init failed on fresh clone"

  local f
  for f in launch.sh verify.sh teardown.sh setup-infra.sh agent-slot.sh \
           provision-toolchain.sh agent-cli.sh harness.env stages.json \
           manifest.json README.md CLAUDE.agent.md; do
    [ -f "$FRESH/.har/$f" ] || fail "init did not produce .har/$f"
  done

  echo "==> har env launch 1 (fresh harness)"
  har "$FRESH" env launch 1 || fail "launch failed on fresh harness"
  echo "==> har env teardown 1"
  har "$FRESH" env teardown 1 --delete-branch || fail "teardown failed on fresh harness"
  echo "✓ Mode 2 passed (scaffold complete, slot lifecycle works)"
}

# ── Milestone-specific assertions ─────────────────────────────────────────────
# Each v1.0.0 milestone PR extends its case below with real checks; a check for
# a feature that has not landed yet must detect absence and skip loudly, never
# fail. See the factory line (.claude/skills/v1-milestone/SKILL.md).
milestone_asserts() {
  case "$MILESTONE" in
    M0)
      echo "──> M0 asserts: scaffold golden check"
      local count
      count=$(find "$FRESH/.har" -maxdepth 1 -type f | wc -l)
      echo "    fresh .har/ top-level files: $count"
      [ "$count" -ge 12 ] || fail "M0: fresh scaffold suspiciously small ($count files)"
      ;;
    M1)
      echo "──> M1 asserts: harness.env pure-config contract (#230)"
      if grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*\(\)' "$FRESH/.har/harness.env"; then
        fail "M1: fresh scaffold harness.env contains function definitions — must be pure KEY=value config"
      fi
      grep -q '^export HARNESS_INFRA_PORT_LANES=' "$FRESH/.har/harness.env" \
        || fail "M1: fresh scaffold harness.env missing HARNESS_INFRA_PORT_LANES"
      [ -f "$FRESH/.har/lib/infra.sh" ] || fail "M1: fresh scaffold missing lib/infra.sh"
      echo "    harness.env is pure config with port lanes; lib/infra.sh present ✓"

      echo "──> M1 asserts: CLI/MCP parity surfaces (#233)"
      # One status implementation: --json must be the structured source with slots.
      har "$CLONE" env status --json | node -e '
        let raw = "";
        process.stdin.on("data", (c) => (raw += c));
        process.stdin.on("end", () => {
          const status = JSON.parse(raw);
          if (!Array.isArray(status.slots) || status.slots.length === 0) {
            console.error("M1: status --json returned no slots");
            process.exit(1);
          }
        });
      ' || fail "M1: har env status --json is not structured"
      echo "    status --json structured ✓"
      har "$CLONE" env artifacts --json >/dev/null || fail "M1: har env artifacts failed"
      echo "    artifacts listing ✓"

      echo "──> M1 asserts: doctor contract checks"
      if har "$CLONE" env doctor >/dev/null 2>&1; then
        echo "    doctor green on adapted harness ✓"
        cp "$CLONE/.har/stages.json" "$ART_DIR/stages.json.bak"
        echo '{"broken": true}' > "$CLONE/.har/stages.json"
        if har "$CLONE" env doctor >/dev/null 2>&1; then
          mv "$ART_DIR/stages.json.bak" "$CLONE/.har/stages.json"
          fail "M1: doctor passed on corrupted stages.json"
        fi
        mv "$ART_DIR/stages.json.bak" "$CLONE/.har/stages.json"
        echo "    doctor red on corrupted stages.json ✓"
      else
        echo "    doctor not available yet — skipping (lands with #232)"
      fi
      ;;
    M2)
      echo "──> M2 asserts: shim parity (extend when #235 lands)"
      echo "    pending: direct ./.har/verify.sh must write run + validation records"
      ;;
    M3)
      echo "──> M3 asserts: plugin/eject (extend when #239/#240 land)"
      ;;
    M4|M5)
      echo "──> $MILESTONE asserts: migration (extend when #241 lands)"
      echo "    pending: maintain-driven migration of the pre-1.0 fixture harness"
      ;;
    generic)
      : ;;
    *)
      fail "unknown HAR_FIXTURE_MILESTONE '$MILESTONE' (expected M0..M5)"
      ;;
  esac
}

echo "==> fixture-e2e gate (agent $AGENT_ID, milestone: $MILESTONE)"
echo "    CLI under test: $HAR_CLI"
existing_harness_mode
fresh_init_mode
milestone_asserts
echo "✓ fixture-e2e gate passed"

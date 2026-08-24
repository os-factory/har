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
  for f in launch.sh verify.sh teardown.sh setup-infra.sh \
           agent-cli.sh harness.env stages.json \
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
      # lib/infra.sh moved into the package in M2 (#234); config purity is the M1 contract.
      echo "    harness.env is pure config with port lanes ✓"

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

      echo "──> M1 asserts: verification as data (#231)"
      node -e '
        const fs = require("fs");
        const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const ids = reg.verificationStages ?? [];
        if (ids.length === 0) { console.error("M1: fresh scaffold has no verificationStages"); process.exit(1); }
        const runnable = new Set(["test", "custom"]);
        for (const id of ids) {
          const st = (reg.stages ?? []).find((s) => s.id === id);
          if (!st || !runnable.has(st.kind)) { console.error(`M1: verificationStages id ${id} does not resolve`); process.exit(1); }
        }
        if (!(reg.stages ?? []).some((s) => s.tier === "quick")) { console.error("M1: no quick-tier stage registered"); process.exit(1); }
      ' "$FRESH/.har/stages.json" || fail "M1: fresh scaffold verificationStages namespace not fully resolvable/tiered"
      # Pre-#234 verify.sh exec'd the runner itself; post-#234 it delegates via har env verify.
      grep -qE 'lib/verify-runner\.mjs|exec har env verify|har" env verify' "$FRESH/.har/verify.sh" \
        || fail "M1: fresh scaffold verify.sh does not delegate to the stage-registry runner"
      if grep -q 'run_quick_smoke' "$FRESH/.har/verify.sh"; then
        fail "M1: fresh scaffold verify.sh still carries inline ecosystem case tables"
      fi
      echo "    verificationStages fully resolvable, tiered, runner-delegated ✓"

      echo "──> M1 asserts: doctor contract checks (#232)"
      har "$CLONE" env doctor >/dev/null 2>&1 \
        || fail "M1: doctor red on the freshly adapted harness"
      echo "    doctor green on adapted harness ✓"

      # doctor --json is structured and machine-checkable (CI contract)
      har "$CLONE" env doctor --json | node -e '
        let raw = "";
        process.stdin.on("data", (c) => (raw += c));
        process.stdin.on("end", () => {
          const report = JSON.parse(raw);
          if (report.ok !== true || !Array.isArray(report.checks) || report.checks.length === 0) {
            console.error("M1: doctor --json missing ok/checks");
            process.exit(1);
          }
        });
      ' || fail "M1: har env doctor --json is not structured"
      echo "    doctor --json structured ✓"

      # Corruption asserts run against the FRESH scaffold: it follows the 1.0
      # contract, where doctor enforces errors (the adapted clone is pre-1.0
      # and degrades contract findings to warnings until #241 migrates it).
      har "$FRESH" env doctor >/dev/null 2>&1 \
        || fail "M1: doctor red on the fresh 1.0 scaffold"
      echo "    doctor green on fresh 1.0 scaffold ✓"

      cp "$FRESH/.har/stages.json" "$ART_DIR/stages.json.bak"
      echo '{"broken": true}' > "$FRESH/.har/stages.json"
      if har "$FRESH" env doctor >/dev/null 2>&1; then
        mv "$ART_DIR/stages.json.bak" "$FRESH/.har/stages.json"
        fail "M1: doctor passed on corrupted stages.json"
      fi
      cp "$ART_DIR/stages.json.bak" "$FRESH/.har/stages.json"
      echo "    doctor red on corrupted stages.json ✓"

      # a misnamed verification id must be caught (resolvable-namespace contract)
      node -e '
        const fs = require("fs");
        const p = process.argv[1];
        const r = JSON.parse(fs.readFileSync(p, "utf8"));
        r.verificationStages = [...(r.verificationStages ?? []), "phantom-stage"];
        fs.writeFileSync(p, JSON.stringify(r, null, 2));
      ' "$FRESH/.har/stages.json"
      if har "$FRESH" env doctor >/dev/null 2>&1; then
        mv "$ART_DIR/stages.json.bak" "$FRESH/.har/stages.json"
        fail "M1: doctor passed on a phantom verificationStages id"
      fi
      cp "$ART_DIR/stages.json.bak" "$FRESH/.har/stages.json"
      echo "    doctor red on phantom verification id ✓"

      # corrupting harness.env must be caught
      cp "$FRESH/.har/harness.env" "$ART_DIR/harness.env.bak"
      echo 'export HARNESS_ECOSYSTM=node' >> "$FRESH/.har/harness.env"
      if har "$FRESH" env doctor >/dev/null 2>&1; then
        cp "$ART_DIR/harness.env.bak" "$FRESH/.har/harness.env"
        fail "M1: doctor passed on corrupted harness.env"
      fi
      cp "$ART_DIR/harness.env.bak" "$FRESH/.har/harness.env"
      echo "    doctor red on corrupted harness.env ✓"
      ;;
    M2)
      echo "──> M2 asserts: runtime in the package (#234)"
      # The bash runtime must be gone from fresh scaffolds — logic lives in the package.
      local gone
      for gone in agent-slot.sh provision-toolchain.sh simulator.sh lib/infra.sh lib/node-pm.sh; do
        [ ! -f "$FRESH/.har/$gone" ] || fail "M2: fresh scaffold still ships runtime bash: .har/$gone"
      done
      echo "    no runtime bash in fresh scaffold ✓"

      local shim lines
      for shim in launch.sh verify.sh teardown.sh setup-infra.sh agent-cli.sh preflight.sh; do
        [ -f "$FRESH/.har/$shim" ] || fail "M2: fresh scaffold missing .har/$shim"
        grep -q 'exec har env\|node_modules/.bin/har' "$FRESH/.har/$shim" \
          || fail "M2: .har/$shim does not delegate to har env"
        if grep -q 'node -e' "$FRESH/.har/$shim"; then
          fail "M2: .har/$shim carries embedded node programs"
        fi
        lines=$(wc -l < "$FRESH/.har/$shim")
        [ "$lines" -le 25 ] || fail "M2: .har/$shim is $lines lines — business logic belongs in the package"
      done
      echo "    generated .har/*.sh are thin delegates ✓"

      # Direct shim execution reaches the packaged runtime (full record parity is #235).
      local bindir="$ART_DIR/bin"
      mkdir -p "$bindir"
      printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$HAR_CLI" > "$bindir/har"
      chmod +x "$bindir/har"
      (cd "$FRESH" && PATH="$bindir:$PATH" ./.har/preflight.sh 1 >/dev/null) \
        || fail "M2: direct ./.har/preflight.sh execution failed"
      echo "    direct shim execution works ✓"

      echo "──> M2 asserts: thin shims with pinned npx fallback (#235)"
      # Fresh shims pin the generating package version for a deterministic npx fallback.
      local pkg_version
      pkg_version="$(node -p "require('$REPO_ROOT/package.json').version")"
      for shim in launch.sh verify.sh teardown.sh setup-infra.sh agent-cli.sh preflight.sh; do
        grep -q "npx --yes @osfactory/har@${pkg_version} " "$FRESH/.har/$shim" \
          || fail "M2: .har/$shim lacks the pinned npx fallback (@${pkg_version})"
        if grep -q '__HAR_VERSION__' "$FRESH/.har/$shim"; then
          fail "M2: .har/$shim still carries the unrendered __HAR_VERSION__ token"
        fi
      done
      echo "    shims pin npx fallback to @osfactory/har@${pkg_version} ✓"

      # Record parity: a launch → verify → teardown cycle driven ONLY through
      # the generated shims must leave the same evidence records as har env.
      # Runs on FRESH — the 1.0 scaffold with shims; CLONE keeps its pre-1.0
      # scripts (no records) until #241 migrates it.
      local shim_marker="$ART_DIR/.m2-shim-start"; touch "$shim_marker"
      "$bindir/har" --version >/dev/null 2>&1 || true
      (cd "$FRESH" && "$bindir/har" env teardown 1 >/dev/null 2>&1) || true
      (cd "$FRESH" && PATH="$bindir:$PATH" ./.har/launch.sh 1 >/dev/null) \
        || fail "M2: direct ./.har/launch.sh execution failed on fresh scaffold"
      # The fresh scaffold is unadapted, so quick verify may report failures —
      # the parity claim is that the shim surface records the run either way.
      (cd "$FRESH" && PATH="$bindir:$PATH" ./.har/verify.sh 1 >/dev/null) || true
      (cd "$FRESH" && PATH="$bindir:$PATH" ./.har/teardown.sh 1 --delete-branch >/dev/null) \
        || fail "M2: direct ./.har/teardown.sh execution failed on fresh scaffold"
      local kind
      for kind in launch verify teardown; do
        find "$FRESH/.har/runs" -name "*_${kind}_*.json" -newer "$shim_marker" 2>/dev/null | grep -q . \
          || fail "M2: shim-driven ${kind} wrote no run record — entry points are not parity"
      done
      echo "    shim-driven launch/verify/teardown all write run records ✓"

      # Commit gate satisfiable from the shim surface: on the ADAPTED clone
      # (where quick verify passes), a shim verify must produce a validation
      # record. CLONE's own verify.sh is pre-1.0 bash until #241 — stand in
      # the generated shim, exactly what migration will install.
      cp "$FRESH/.har/verify.sh" "$CLONE/.har/verify.sh"
      (cd "$CLONE" && "$bindir/har" env launch 1 >/dev/null 2>&1) \
        || fail "M2: launch on adapted clone failed for shim-verify parity check"
      # --full: the pre-1.0 clone's stages.json has no quick-tier stages yet
      # (#241 migrates it); full resolves its verificationStages list.
      (cd "$CLONE" && PATH="$bindir:$PATH" ./.har/verify.sh 1 --full >/dev/null) \
        || fail "M2: shim verify failed on the adapted clone"
      find "$CLONE/.har/validations" -name '*.json' -newer "$shim_marker" 2>/dev/null | grep -q . \
        || fail "M2: shim verify wrote no validation record — commit gate not satisfiable from the shim surface"
      (cd "$CLONE" && "$bindir/har" env teardown 1 >/dev/null 2>&1) || true
      git -C "$CLONE" checkout -- .har/verify.sh 2>/dev/null || true
      echo "    shim verify writes validation records (commit gate satisfiable from any surface) ✓"
      ;;
    M3)
      echo "──> M3 asserts: two-signal drift (#237)"
      # Fresh 1.0 scaffold: adapt a file, finalize — drift must be zero.
      echo "# repo-specific adaptation (M3 gate)" >> "$FRESH/.har/verify.sh"
      har "$FRESH" env maintain --finalize --summary "M3 drift assert: adapted verify.sh" >/dev/null 2>&1 \
        || fail "M3: maintain --finalize failed on fresh scaffold"
      har "$FRESH" env maintain >/dev/null 2>&1 || true
      node -e '
        const fs = require("fs");
        const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (r.actions.length !== 0) {
          console.error("M3: freshly finalized harness reports drift actions:", r.actions.map(a=>`${a.file}(${a.kind})`).join(", "));
          process.exit(1);
        }
        if (r.adapted.length !== 0) {
          console.error("M3: finalize did not bless adapted files:", r.adapted.join(", "));
          process.exit(1);
        }
      ' "$FRESH/.har/maintain/drift-report.json" \
        || fail "M3: adapted+finalized harness is not drift-clean"
      echo "    adapted + finalized harness reports zero drift ✓"

      # Post-finalize user edit → adapted (informational), never an action.
      echo "# post-finalize edit (M3 gate)" >> "$FRESH/.har/verify.sh"
      har "$FRESH" env maintain >/dev/null 2>&1 || true
      node -e '
        const fs = require("fs");
        const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (!r.adapted.includes("verify.sh")) { console.error("M3: post-finalize edit not reported as adapted"); process.exit(1); }
        if (r.actions.some(a => a.file === "verify.sh")) { console.error("M3: user-adapted file raised a drift action"); process.exit(1); }
      ' "$FRESH/.har/maintain/drift-report.json" \
        || fail "M3: user-adapted signal wrong"
      echo "    post-finalize edit → user-adapted, no action ✓"

      # Upstream update on a user-adapted file → conflict (simulated by
      # rewinding the recorded template baseline in the manifest).
      node -e '
        const fs = require("fs");
        const p = process.argv[1];
        const m = JSON.parse(fs.readFileSync(p, "utf8"));
        m.templateChecksums["verify.sh"] = "0000000000000000";
        fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
      ' "$FRESH/.har/manifest.json"
      har "$FRESH" env maintain >/dev/null 2>&1 || true
      node -e '
        const fs = require("fs");
        const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const a = r.actions.find(a => a.file === "verify.sh");
        if (!a || a.kind !== "conflict") { console.error("M3: upstream update on adapted file is not a conflict:", a && a.kind); process.exit(1); }
      ' "$FRESH/.har/maintain/drift-report.json" \
        || fail "M3: conflict signal wrong"
      har "$FRESH" env maintain --finalize --summary "M3 drift assert: reset baseline" >/dev/null 2>&1 || true
      echo "    upstream update on adapted file → conflict ✓"

      echo "──> M3 asserts: lifecycle hooks (#238)"
      # Hooks land in the runtime, so the fresh 1.0 scaffold honors them with
      # zero adaptation: drop scripts into .har/hooks/ and drive the lifecycle.
      local hooks_bindir="$ART_DIR/bin"
      mkdir -p "$hooks_bindir"
      printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$HAR_CLI" > "$hooks_bindir/har"
      chmod +x "$hooks_bindir/har"
      local hook_log="$FRESH/.hook-fired"
      rm -f "$hook_log"
      mkdir -p "$FRESH/.har/hooks"
      printf '#!/usr/bin/env bash\necho "$HAR_HOOK:$AGENT_ID:$HAR_HOOK_CONTRACT" >> %q\n' "$hook_log" \
        > "$FRESH/.har/hooks/pre-launch.sh"
      cp "$FRESH/.har/hooks/pre-launch.sh" "$FRESH/.har/hooks/post-teardown.sh"
      chmod +x "$FRESH/.har/hooks/pre-launch.sh" "$FRESH/.har/hooks/post-teardown.sh"

      (cd "$FRESH" && "$hooks_bindir/har" env teardown 1 >/dev/null 2>&1) || true
      rm -f "$hook_log"
      (cd "$FRESH" && "$hooks_bindir/har" env launch 1 >/dev/null) \
        || fail "M3: launch failed with hooks installed"
      grep -q '^pre-launch:1:1$' "$hook_log" 2>/dev/null \
        || fail "M3: pre-launch hook did not fire with the v1 env contract"
      echo "    pre-launch hook fires with the v1 contract ✓"

      # A failing pre-verify hook must abort verify with attribution.
      printf '#!/usr/bin/env bash\nexit 42\n' > "$FRESH/.har/hooks/pre-verify.sh"
      chmod +x "$FRESH/.har/hooks/pre-verify.sh"
      local hook_verify_out
      if hook_verify_out=$(cd "$FRESH" && "$hooks_bindir/har" env verify 1 2>&1); then
        fail "M3: verify passed despite a failing pre-verify hook"
      fi
      echo "$hook_verify_out" | grep -q 'pre-verify hook failed (exit 42)' \
        || fail "M3: verify failure not attributed to the pre-verify hook"
      rm -f "$FRESH/.har/hooks/pre-verify.sh"
      echo "    failing pre-verify hook blocks verify with attribution ✓"

      (cd "$FRESH" && "$hooks_bindir/har" env teardown 1 --delete-branch >/dev/null) \
        || fail "M3: teardown failed with hooks installed"
      grep -q '^post-teardown:1:1$' "$hook_log" 2>/dev/null \
        || fail "M3: post-teardown hook did not fire"
      echo "    post-teardown hook fires ✓"

      # Hooks are user-owned: doctor stays green with hooks installed.
      (cd "$FRESH" && "$hooks_bindir/har" env doctor >/dev/null 2>&1) \
        || fail "M3: doctor red with valid hooks installed"
      echo "    doctor green with hooks installed ✓"
      rm -rf "$FRESH/.har/hooks" "$hook_log"

      echo "──> M3 asserts: eject/plugins (extend when #239/#240 land)"
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

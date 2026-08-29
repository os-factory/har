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
  for f in harness.env stages.json manifest.json README.md; do
    [ -f "$FRESH/.har/$f" ] || fail "init did not produce .har/$f"
  done
  for f in launch.sh verify.sh teardown.sh setup-infra.sh agent-cli.sh preflight.sh attach.sh; do
    [ ! -f "$FRESH/.har/$f" ] || fail "init wrote retired lifecycle wrapper .har/$f (#314)"
  done
  # #301: the instruction surface is AGENTS.md; the harness detail is README.md.
  [ ! -f "$FRESH/.har/CLAUDE.agent.md" ] || fail "init produced retired .har/CLAUDE.agent.md"
  # CLAUDE.md is managed only when Claude is a selected agent target, so drive
  # that path explicitly rather than inferring it from a file the fixture may
  # already ship. The fixture's own CLAUDE.md is hand-written, so this also
  # proves HAR preserves user content and only prepends the import (#301).
  local claude_before claude_after
  claude_before="$(cat "$FRESH/CLAUDE.md" 2>/dev/null || true)"
  har "$FRESH" env maintain --yes --agents claude --no-cursor-rule >/dev/null 2>&1 \
    || fail "maintain --agents claude failed on the fresh harness"
  [ -f "$FRESH/CLAUDE.md" ] || fail "maintain --agents claude did not write CLAUDE.md"
  claude_after="$(cat "$FRESH/CLAUDE.md")"
  [ "$(grep -m1 -v '^[[:space:]]*$' "$FRESH/CLAUDE.md" | tr -d '[:space:]')" = "@AGENTS.md" ] \
    || fail "CLAUDE.md does not lead with the @AGENTS.md import (#301)"
  if [ -n "$claude_before" ]; then
    printf '%s' "$claude_before" | while IFS= read -r line; do
      [ -n "$line" ] || continue
      grep -qF "$line" "$FRESH/CLAUDE.md" || fail "CLAUDE.md lost pre-existing content: $line"
    done
  fi
  # Idempotent: a second pass must not stack imports.
  har "$FRESH" env maintain --yes --agents claude --no-cursor-rule >/dev/null 2>&1 \
    || fail "second maintain --agents claude failed"
  [ "$(cat "$FRESH/CLAUDE.md")" = "$claude_after" ] \
    || fail "CLAUDE.md is not idempotent across maintain runs (#301)"
  [ "$(grep -c '^@AGENTS\.md$' "$FRESH/CLAUDE.md")" = "1" ] \
    || fail "CLAUDE.md accumulated duplicate @AGENTS.md imports"
  grep -q 'har:agent-environment:start' "$FRESH/AGENTS.md" \
    || fail "init did not write the managed AGENTS.md block"
  if sed -n '/har:agent-environment:start/,/har:agent-environment:end/p' "$FRESH/AGENTS.md" \
      | grep -qE '\./\.har/[a-z-]+\.sh'; then
    fail "AGENTS.md block teaches the shell surface on a managed (non-ejected) harness (#301)"
  fi

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
      [ "$count" -ge 8 ] || fail "M0: fresh scaffold suspiciously small ($count files)"
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
      # #314: lifecycle wrappers are not generated — verify dispatches by kind.
      [ ! -f "$FRESH/.har/verify.sh" ] || fail "M1: fresh scaffold still wrote verify.sh (#314)"
      echo "    verificationStages fully resolvable, tiered, no verify.sh wrapper ✓"

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

      local retired
      for retired in launch.sh verify.sh teardown.sh setup-infra.sh agent-cli.sh preflight.sh attach.sh; do
        [ ! -f "$FRESH/.har/$retired" ] || fail "M2: fresh scaffold still ships retired wrapper .har/$retired (#314)"
      done
      echo "    no lifecycle wrappers in fresh scaffold ✓"

      # Record parity: launch → verify → teardown through CLI writes run records.
      local bindir="$ART_DIR/bin"
      mkdir -p "$bindir"
      printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$HAR_CLI" > "$bindir/har"
      chmod +x "$bindir/har"
      local cli_marker="$ART_DIR/.m2-cli-start"; touch "$cli_marker"
      (cd "$FRESH" && "$bindir/har" env teardown 1 >/dev/null 2>&1) || true
      (cd "$FRESH" && "$bindir/har" env launch 1 >/dev/null) \
        || fail "M2: har env launch failed on fresh scaffold"
      (cd "$FRESH" && "$bindir/har" env verify 1 >/dev/null) || true
      (cd "$FRESH" && "$bindir/har" env teardown 1 --delete-branch >/dev/null) \
        || fail "M2: har env teardown failed on fresh scaffold"
      local kind
      for kind in launch verify teardown; do
        find "$FRESH/.har/runs" -name "*_${kind}_*.json" -newer "$cli_marker" 2>/dev/null | grep -q . \
          || fail "M2: CLI-driven ${kind} wrote no run record"
      done
      echo "    CLI-driven launch/verify/teardown all write run records ✓"

      (cd "$CLONE" && "$bindir/har" env launch 1 >/dev/null 2>&1) \
        || fail "M2: launch on adapted clone failed for verify parity check"
      (cd "$CLONE" && "$bindir/har" env verify 1 --full >/dev/null) \
        || fail "M2: har env verify failed on the adapted clone"
      find "$CLONE/.har/validations" -name '*.json' -newer "$cli_marker" 2>/dev/null | grep -q . \
        || fail "M2: CLI verify wrote no validation record — commit gate not satisfiable"
      (cd "$CLONE" && "$bindir/har" env teardown 1 >/dev/null 2>&1) || true
      echo "    CLI verify writes validation records (commit gate satisfiable) ✓"
      ;;
    M3)
      echo "──> M3 asserts: two-signal drift (#237)"
      # Fresh 1.0 scaffold: adapt a file, finalize — drift must be zero.
      echo "# repo-specific adaptation (M3 gate)" >> "$FRESH/.har/README.md"
      har "$FRESH" env maintain --finalize --summary "M3 drift assert: adapted verify.sh" >/dev/null 2>&1 \
        || fail "M3: maintain --finalize failed on fresh scaffold"
      # (adapted README.md — lifecycle wrappers are not generated)
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
      echo "# post-finalize edit (M3 gate)" >> "$FRESH/.har/README.md"
      har "$FRESH" env maintain >/dev/null 2>&1 || true
      node -e '
        const fs = require("fs");
        const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (!r.adapted.includes("README.md")) { console.error("M3: post-finalize edit not reported as adapted"); process.exit(1); }
        if (r.actions.some(a => a.file === "README.md")) { console.error("M3: user-adapted file raised a drift action"); process.exit(1); }
      ' "$FRESH/.har/maintain/drift-report.json" \
        || fail "M3: user-adapted signal wrong"
      echo "    post-finalize edit → user-adapted, no action ✓"

      # Upstream update on a user-adapted file → conflict (simulated by
      # rewinding the recorded template baseline in the manifest).
      node -e '
        const fs = require("fs");
        const p = process.argv[1];
        const m = JSON.parse(fs.readFileSync(p, "utf8"));
        m.templateChecksums["README.md"] = "0000000000000000";
        fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
      ' "$FRESH/.har/manifest.json"
      har "$FRESH" env maintain >/dev/null 2>&1 || true
      node -e '
        const fs = require("fs");
        const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const a = r.actions.find(a => a.file === "README.md");
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

      echo "──> M3 asserts: explicit runtime ownership via eject (#239)"
      if ! har "$FRESH" env eject --help >/dev/null 2>&1; then
        echo "    SKIP: har env eject not available yet (#239 not landed in this build)"
      else
        # Eject on the fresh scaffold: vendored runtime + user-owned scripts,
        # recorded in the manifest, doctor still green, adopt reverses it.
        har "$FRESH" env eject --yes || fail "M3: har env eject failed"
        [ -f "$FRESH/.har/runtime/har.cjs" ] || fail "M3: eject did not vendor .har/runtime/har.cjs"
        [ ! -f "$FRESH/.har/launch.sh" ] || fail "M3: eject wrote a launch.sh wrapper (#314)"
        node -e '
          const m = require(process.argv[1]);
          if (m.ejected !== true || !m.ejectedVersion) { console.error("M3: manifest missing ejected/ejectedVersion"); process.exit(1); }
        ' "$FRESH/.har/manifest.json" || fail "M3: eject not recorded in manifest.json"
        echo "    eject vendors runtime (no wrappers) and records the choice ✓"

        har "$FRESH" env doctor >/dev/null 2>&1 || fail "M3: doctor red on an intact ejected harness"
        echo "    doctor green on ejected harness ✓"

        # Offline invocation: the vendored bundle is executable with node.
        (cd "$FRESH" && node .har/runtime/har.cjs env --help >/dev/null) \
          || fail "M3: node .har/runtime/har.cjs env --help failed"
        echo "    ejected runtime is invocable via node .har/runtime/har.cjs ✓"

        # Reversible: adopt removes the vendored runtime and clears the record.
        har "$FRESH" env adopt || fail "M3: har env adopt failed"
        [ ! -d "$FRESH/.har/runtime" ] || fail "M3: adopt left .har/runtime/ behind"
        [ ! -f "$FRESH/.har/launch.sh" ] || fail "M3: adopt restored a launch.sh wrapper (#314)"
        node -e '
          const m = require(process.argv[1]);
          if (m.ejected || m.ejectedVersion) { console.error("M3: adopt did not clear eject flags"); process.exit(1); }
        ' "$FRESH/.har/manifest.json" || fail "M3: adopt did not clear the manifest record"
        har "$FRESH" env doctor >/dev/null 2>&1 || fail "M3: doctor red after adopt"
        echo "    adopt removes the vendored runtime and clears the record ✓"
      fi
      echo "──> M3 asserts: local plugins (#240)"
      # #240 — local plugins: create → install → stage resolves in the registry
      if har "$FRESH" plugin create --help >/dev/null 2>&1; then
        har "$FRESH" plugin create fixture-check --description "M3 fixture check" --force \
          || fail "M3: har plugin create failed"
        [ -f "$FRESH/.har/plugins/fixture-check/template.manifest.json" ] \
          || fail "M3: plugin create wrote no manifest"
        har "$FRESH" env add-plugin fixture-check --force \
          || fail "M3: add-plugin of the local plugin failed"
        grep -q '"fixture-check"' "$FRESH/.har/stages.json" \
          || fail "M3: local plugin stage not registered in stages.json"
        grep -q '"source": "local"' "$FRESH/.har/plugins.json" \
          || fail "M3: plugins.json ledger does not record source \"local\""
        # add-stage --custom is retired: must fail and point at har plugin create
        if har "$FRESH" env add-stage nope --custom >/dev/null 2>&1; then
          fail "M3: har env add-stage --custom still succeeds — removed in 1.0"
        fi
        echo "    local plugin create → install → stage registered (ledger source: local) ✓"
      else
        echo "    skip: har plugin create not available yet (#240 not landed)"
      fi
      ;;
    M4|M5)
      echo "──> $MILESTONE asserts: pre-1.0 → 1.0 migration (#241)"
      # The fixture clone ships a pre-1.0 adapted harness (vendored runtime
      # bash, shell functions in harness.env, custom HARNESS_TEMPLATE_SQLITE
      # key). Drive the full migration path on it: detect → prompt → apply →
      # lift residue (this script plays the coding agent) → doctor → verify.
      if ! har "$CLONE" env maintain --help 2>&1 | grep -q -- '--migrate'; then
        echo "    SKIP: har env maintain --migrate not available yet (#241 not landed in this build)"
      else
        ensure_clone "$CLONE"   # reset to the pristine pre-1.0 shape
        har "$CLONE" env cleanup >/dev/null 2>&1 || true
        har "$CLONE" env teardown 1 >/dev/null 2>&1 || true

        [ -f "$CLONE/.har/agent-slot.sh" ] || fail "M4: fixture clone lost its pre-1.0 shape (agent-slot.sh missing)"
        grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*\(\)' "$CLONE/.har/harness.env" \
          || fail "M4: fixture harness.env carries no pre-1.0 shell functions"

        # 1) Plain maintain: detect + prompt, but change NOTHING (compat window).
        har "$CLONE" env maintain --yes >/dev/null 2>&1 || fail "M4: maintain failed on the pre-1.0 harness"
        [ -f "$CLONE/.har/MIGRATE-PROMPT.md" ] || fail "M4: maintain wrote no MIGRATE-PROMPT.md"
        [ -f "$CLONE/.har/migrate/plan.json" ] || fail "M4: maintain wrote no migration plan"
        [ -f "$CLONE/.har/agent-slot.sh" ] || fail "M4: plain maintain deleted machinery — compat window violated"
        if grep -q 'exec har env' "$CLONE/.har/launch.sh"; then
          fail "M4: plain maintain rewrote launch.sh — compat window violated"
        fi
        grep -q 'HARNESS_TEMPLATE_SQLITE' "$CLONE/.har/MIGRATE-PROMPT.md" \
          || fail "M4: MIGRATE prompt does not surface the custom HARNESS_TEMPLATE_SQLITE residue"
        echo "    maintain detects pre-1.0, writes prompt+plan, changes nothing ✓"

        # 2) Mechanical migration: lifecycle wrappers deleted, machinery out, env pure.
        har "$CLONE" env maintain --migrate --yes >/dev/null 2>&1 || fail "M4: maintain --migrate failed"
        local mig_script
        for mig_script in launch.sh verify.sh teardown.sh setup-infra.sh; do
          [ ! -f "$CLONE/.har/$mig_script" ] \
            || fail "M4: migration left lifecycle wrapper .har/$mig_script (#314)"
        done
        [ ! -f "$CLONE/.har/provision-toolchain.sh" ] || fail "M4: migration left runtime machinery .har/provision-toolchain.sh"
        # agent-slot.sh is still sourced by the adapted stages/browser-e2e.sh:
        # classify-and-lift keeps it (deleting would break the stage) and puts
        # the rewrite on the prompt.
        [ -f "$CLONE/.har/agent-slot.sh" ] \
          || fail "M4: migration deleted agent-slot.sh while stages/browser-e2e.sh still sources it"
        grep -q 'agent-slot.sh' "$CLONE/.har/MIGRATE-PROMPT.md" \
          || fail "M4: retained machinery not surfaced in the MIGRATE prompt"
        if grep -qE '^[a-zA-Z_][a-zA-Z0-9_]*\(\)' "$CLONE/.har/harness.env"; then
          fail "M4: migrated harness.env still contains shell functions"
        fi
        [ -f "$CLONE/.har/migrate/backup/launch.sh" ] || fail "M4: migration kept no backup of launch.sh"
        node -e '
          const m = require(process.argv[1]);
          if (m.runtimeVersion !== "1.0.0") { console.error("M4: manifest runtimeVersion not stamped:", m.runtimeVersion); process.exit(1); }
          if (!m.migratedFrom) { console.error("M4: manifest migratedFrom not recorded"); process.exit(1); }
        ' "$CLONE/.har/manifest.json" || fail "M4: migration not recorded in manifest.json"
        echo "    mechanical migration: shims + pure config + backups + manifest stamp ✓"

        # Custom verification ids whose commands lived in the vendored
        # verify.sh case table must have been dropped from verificationStages
        # (mechanically unresolvable) and surfaced as residue in the prompt.
        node -e '
          const fs = require("fs");
          const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const ids = r.verificationStages ?? [];
          for (const id of ["node-build", "api-health", "ml-tests"]) {
            if (ids.includes(id)) { console.error(`M4: unresolvable verification id ${id} survived migration`); process.exit(1); }
          }
        ' "$CLONE/.har/stages.json" || fail "M4: phantom verification ids not reconciled"
        grep -q 'node-build' "$CLONE/.har/MIGRATE-PROMPT.md" \
          || fail "M4: dropped verification ids not surfaced in the MIGRATE prompt"
        echo "    unresolvable verification ids dropped + surfaced as residue ✓"

        # 3a) Residue lift — play the coding agent: re-register the vendored
        # verify.sh case-table checks as plain stages.json command stages
        # (commands read from the backup; api-health stays dropped — the
        # packaged runtime's health check covers HARNESS_HEALTH_CHECK_PATH).
        node -e '
          const fs = require("fs");
          const p = process.argv[1];
          const r = JSON.parse(fs.readFileSync(p, "utf8"));
          const add = [
            { id: "node-build", kind: "test", description: "Production build (lifted from pre-1.0 verify.sh)", command: "NODE_ENV=production ${NPM_BIN:-npm} run build", artifacts: [] },
            { id: "ml-tests", kind: "test", description: "ML test suite (lifted from pre-1.0 verify.sh)", command: "${NPM_BIN:-npm} run test:ml", artifacts: [] },
          ];
          for (const st of add) {
            if (!r.stages.some((s) => s.id === st.id)) r.stages.push(st);
            if (!r.verificationStages.includes(st.id)) r.verificationStages.push(st.id);
          }
          fs.writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
        ' "$CLONE/.har/stages.json" || fail "M4: could not re-register lifted verification stages"
        echo "    residue lift: vendored verify checks re-registered as command stages ✓"

        # 3b) Residue lift — play the coding agent: rewrite browser-e2e.sh
        # against the 1.0 stage surface (WORK_DIR/ENV_FILE/AGENT_ID exported by
        # the verify runner), then delete the retained agent-slot.sh.
        node -e '
          const fs = require("fs");
          const p = process.argv[1];
          let c = fs.readFileSync(p, "utf8");
          const lines = c.split("\n");
          const start = lines.findIndex((l) => l.startsWith("ENV_FILE=\"$(resolve_agent_env_file"));
          const end = lines.findIndex((l, i) => i > start && l.trim() === "}");
          if (start < 0 || end < 0) { console.error("browser-e2e.sh resolve block not found"); process.exit(1); }
          lines.splice(start, end - start + 1,
            "ENV_FILE=\"${ENV_FILE:-$REPO_ROOT/.env.agent.${AGENT_ID}}\"",
            "[ -f \"$ENV_FILE\" ] || { echo \"No .env.agent.${AGENT_ID} found — launch slot ${AGENT_ID} first.\" >&2; exit 1; }");
          c = lines.join("\n");
          c = c.replace(/^source "\$HARNESS_DIR\/agent-slot\.sh"$/m, ": # agent-slot.sh retired (1.0 migration)\nnow_ms() { date +%s%3N; }");
          c = c.replace("validate_agent_id \"$AGENT_ID\"", "[[ \"$AGENT_ID\" =~ ^[0-9]+$ ]] || { echo \"invalid agent id: $AGENT_ID\" >&2; exit 2; }");
          c = c.replace("WORK_DIR=\"$(resolve_agent_work_dir \"$ENV_FILE\")\"", "WORK_DIR=\"${WORK_DIR:-$(cd \"$(dirname \"$ENV_FILE\")\" && pwd)}\"");
          fs.writeFileSync(p, c);
        ' "$CLONE/.har/stages/browser-e2e.sh" || fail "M4: could not rewrite browser-e2e.sh off agent-slot.sh"
        if grep -E '^[[:space:]]*source .*agent-slot\.sh' "$CLONE/.har/stages/browser-e2e.sh" | grep -qv '^[[:space:]]*#'; then
          fail "M4: browser-e2e.sh still sources agent-slot.sh after the lift"
        fi
        rm -f "$CLONE/.har/agent-slot.sh"
        echo "    residue lift: browser-e2e.sh rewritten to the 1.0 surface, agent-slot.sh deleted ✓"

        # 3c) Residue lift — play the coding agent: the pre-1.0 launch.sh cloned
        # a per-slot SQLite DB from the template; per MIGRATE-PROMPT.md that
        # behavior belongs in a post-launch lifecycle hook.
        [ -f "$CLONE/.har/state/template/cars.sqlite" ] \
          || fail "M4: SQLite template missing — Mode 1 should have provisioned it"
        mkdir -p "$CLONE/.har/hooks"
        cat > "$CLONE/.har/hooks/post-launch.sh" <<'HOOK'
#!/usr/bin/env bash
# Lifted from the pre-1.0 vendored launch.sh (migration residue, #241):
# per-slot SQLite database cloned from the shared template.
set -euo pipefail
TEMPLATE="$HAR_HARNESS_DIR/state/template/cars.sqlite"
[ -f "$TEMPLATE" ] || { echo "post-launch: missing SQLite template $TEMPLATE" >&2; exit 1; }
mkdir -p "$WORK_DIR/data"
[ -f "$WORK_DIR/data/cars.sqlite" ] || cp "$TEMPLATE" "$WORK_DIR/data/cars.sqlite"
HOOK
        chmod +x "$CLONE/.har/hooks/post-launch.sh"

        if [ "$MILESTONE" = "M5" ]; then
          # M5 (#242 dogfood) — migration polish found while migrating this
          # repo's three harnesses:
          # a) stock files new in the 1.0 surface are installed by --migrate
          [ -f "$CLONE/.har/stages/readiness.sh" ] \
            || fail "M5: migration did not install stages/readiness.sh"
          [ -f "$CLONE/.har/lib/verify-runner.mjs" ] \
            || fail "M5: migration did not install lib/verify-runner.mjs"
          # b) HARNESS_ECOSYSTEM=auto resolves to real ecosystem defaults —
          #    never the placeholder smoke
          if grep -q 'No stock smoke for HARNESS_ECOSYSTEM' "$CLONE/.har/stages.json"; then
            fail "M5: ecosystem defaults registered a placeholder smoke (auto not resolved)"
          fi
          # c) hooks receive harness.env config: guard the lifted post-launch
          #    hook on a HARNESS_* key — if config were missing the hook would
          #    exit 1, the per-slot DB never be cloned, and full verify fail.
          sed -i '1a [ -n "${HARNESS_PROJECT_NAME:-}" ] || { echo "post-launch: harness.env config missing from hook env" >&2; exit 1; }' \
            "$CLONE/.har/hooks/post-launch.sh"
          # d) #290: plugin templates ship on the 1.0 stage surface — a fresh
          #    plugin install must not reference the retired machinery
          if grep -rlE 'source "\$HARNESS_DIR/agent-slot\.sh"|provision-toolchain\.sh' \
              "$REPO_ROOT/dist/templates/plugins" --include='*.sh' >/dev/null 2>&1; then
            fail "M5: plugin templates still reference retired machinery (agent-slot.sh / provision-toolchain.sh)"
          fi
          # e) #297: no surviving script may load machinery the migration
          #    deleted. attach.sh was the live case — it stayed vendored while
          #    agent-slot.sh was removed underneath it. Scan only the LIVE
          #    surface (harness root, stages/, hooks/, local plugins): the
          #    transient ledgers .har/migrate/backup/ and .har/maintain/ keep
          #    pre-1.0 snapshots on purpose and must still contain those lines.
          local stale_loader=""
          local candidate
          while IFS= read -r candidate; do
            [ -n "$candidate" ] || continue
            if grep -vE '^[[:space:]]*#' "$candidate" \
                | grep -qE '(source|\.|bash|exec)[^#]*(agent-slot|provision-toolchain|simulator)\.sh'; then
              stale_loader="$candidate"
              break
            fi
          done < <(
            find "$CLONE/.har" -maxdepth 1 -name '*.sh' -type f 2>/dev/null
            find "$CLONE/.har/stages" "$CLONE/.har/hooks" -maxdepth 1 -name '*.sh' -type f 2>/dev/null
            find "$CLONE/.har/plugins" -maxdepth 3 -name '*.sh' -type f 2>/dev/null
          )
          if [ -n "$stale_loader" ]; then
            fail "M5: ${stale_loader#$CLONE/} still loads retired runtime machinery (#297)"
          fi
          echo "    M5: stock files installed + auto ecosystem resolved + hook config guard armed + plugin templates on the 1.0 surface + no retired-machinery loads ✓"
        fi

        # 4) Doctor must be green on the migrated harness (1.0 contract enforced).
        har "$CLONE" env doctor >/dev/null 2>&1 || fail "M4: doctor red on the migrated harness"
        echo "    doctor green on migrated harness (1.0 contract) ✓"

        # 5) The muscle memory keeps working: full lifecycle on the migrated
        # harness, driven end-to-end through the 1.0 runtime + shims.
        local mig_marker="$ART_DIR/.m4-migrate-start"; touch "$mig_marker"
        har "$CLONE" env launch 1 || fail "M4: launch failed on the migrated harness"
        har "$CLONE" env verify 1 --full || fail "M4: full verify failed on the migrated harness"
        har "$CLONE" env complete 1 --skip-verify || fail "M4: complete failed on the migrated harness"
        find "$CLONE/.har/validations" -name '*.json' -newer "$mig_marker" | grep -q . \
          || fail "M4: full verify on the migrated harness wrote no validation record"
        echo "    migrated harness: launch → full verify → complete, records written ✓"

        # 6) Finalize records the migration and clears the migration artifacts.
        har "$CLONE" env maintain --finalize --summary "M4 gate: migrated pre-1.0 fixture harness to 1.0" \
          >/dev/null 2>&1 || fail "M4: maintain --finalize failed post-migration"
        [ ! -d "$CLONE/.har/migrate" ] || fail "M4: finalize left .har/migrate/ behind"
        [ ! -f "$CLONE/.har/MIGRATE-PROMPT.md" ] || fail "M4: finalize left MIGRATE-PROMPT.md behind"
        echo "    finalize clears migration artifacts ✓"

        if [ "$MILESTONE" = "M5" ]; then
          # e) #195: add-plugin leaves a structured adaptation prompt for the
          #    coding agent. Runs after the lifecycle asserts so the extra
          #    stage never joins the verified pipeline above.
          har "$CLONE" env add-plugin gitleaks --force >/dev/null 2>&1 \
            || fail "M5: add-plugin gitleaks failed on the migrated harness"
          [ -f "$CLONE/.har/ADAPT-PROMPT-gitleaks.md" ] \
            || fail "M5: add-plugin wrote no adaptation prompt (#195)"
          grep -q 'Prove it green' "$CLONE/.har/ADAPT-PROMPT-gitleaks.md" \
            || fail "M5: plugin adaptation prompt missing its verify section"
          echo "    M5: add-plugin writes the agent adaptation prompt (#195) ✓"
        fi
      fi
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

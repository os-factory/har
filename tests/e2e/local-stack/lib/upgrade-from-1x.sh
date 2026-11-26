# shellcheck shell=bash
# The 1.x → 2.0 upgrade of a machine connected to the hosted receiver
# (run.sh --upgrade-from-1x; sourced by run.sh, which provides the receivers,
# the replayed agent turns and the helpers).
#
# Twice, once without and once with 1.x trajectory forwarding: a sandbox HOME
# where HAR 1.x (`@osfactory/har@1`) initialised a repository, chose the `full`
# telemetry level and connected to the hosted receiver with an ingest key
# (`har hq connect --api-key`, attaching the repository). The same HOME then runs
# the 2.0 CLI under test, non-interactively (stdin closed, no TTY): one replayed
# Claude Code + Codex session in a slot, a full verify and a commit. Checks:
#   - the `hq` destination is added by the first 2.0 command, with one notice,
#     and takes logs (the trajectory) only when 1.x forwarded it;
#   - the "full experience" hint is printed once when it did not, never a prompt;
#   - the repository stays attached; the hook commands carry today's flags;
#   - `har env maintain` removes the 1.x stage-runner copy in .har/lib/ and keeps
#     the project's verificationStages;
#   - records (run, stages, logs, proof) and usage (Claude Code and Codex) reach
#     the hosted receiver's v2 endpoints;
#   - the trajectory reaches the hosted receiver only with forwarding, while
#     Mission Control (local) holds it either way.

PORTAL_URL="${HOSTED_INGEST%/ingest}"
[ "$PORTAL_URL" != "$HOSTED_INGEST" ] || die "--upgrade-from-1x: the hosted ingest base ($HOSTED_INGEST) must end in /ingest, as 2.0 derives it from the portal URL"
if [ -z "$HAR1_CLI" ]; then
  step "install HAR 1.x" npm install --prefix "$TMP/v1/prefix" --no-audit --no-fund --ignore-scripts "@osfactory/har@1"
  HAR1_CLI="$TMP/v1/prefix/node_modules/@osfactory/har/dist/index.js"
fi
[ -f "$HAR1_CLI" ] || die "no HAR 1.x CLI at $HAR1_CLI"
HAR1_VERSION="$(cd "$TMP" && node "$HAR1_CLI" --version 2>/dev/null)"
log "upgrade from HAR $HAR1_VERSION to $CLI"

# Every check line of this mode names its variant.
ucheck() { # <check> [target]
  local line
  line="$("${CHECKS[@]}" "$1" "$TMP/state.json" "${@:2}" 2>>"$LOG")" || line="FAIL $1${2:+ @$2}: checks.mjs crashed (see $LOG)"
  line="${line%%:*} [$UTAG]:${line#*:}"
  echo "$line"
  case "$line" in PASS* | SKIP*) ;; *) FAILS=$((FAILS + 1)) ;; esac
}

# Runs a command, appending its output to the variant's transcript ($UOUT) and the run log.
up() {
  echo "### [$UTAG] $*" >>"$LOG"
  "$@" >"$UV/last.txt" 2>&1
  local code=$?
  cat "$UV/last.txt" >>"$UOUT"
  cat "$UV/last.txt" >>"$LOG"
  [ $code = 0 ] || die "[$UTAG] $* failed (exit $code)"
}

upgrade_variant() { # <0|1>: 1.x trajectory forwarding off / on
  local forward=$1
  UTAG="upgrade-from-1x trajectory-$([ "$forward" = 1 ] && echo on || echo off)"
  UV="$TMP/upgrade-$forward"
  UOUT="$UV/v2-output.txt"
  local repo="$UV/repo" repo_url="https://example.test/har-local-stack/$RUN_TAG-upgrade-$forward.git"
  local work_id="upgrade-$forward"
  mkdir -p "$UV"/{home,bin,repo,collector}
  : >"$UOUT"
  cp "$TMP/bin/docker" "$UV/bin/docker"
  ln -s "$GIT_FACTORY" "$UV/bin/git-factory"
  printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$(command -v node)" "$HAR1_CLI" >"$UV/bin/har"
  chmod +x "$UV/bin/har"
  # The run's sandbox, on this variant's HOME, with no hosted receiver env:
  # 2.0 must find the connection 1.x saved. stdin closed: nothing can prompt.
  sandbox() {
    env -i \
      PATH="$UV/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" \
      HOME="$UV/home" TMPDIR="$TMP" TERM=dumb \
      HAR_CONTROL_API_URL="$MC_URL" \
      HAR_OTEL_HOOKS_PACKAGE="$OTEL_HOOK_PACKAGE" \
      npm_config_cache="${HAR_E2E_NPM_CACHE:-$UV/home/.npm}" \
      GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test \
      GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test \
      "$@" </dev/null
  }
  CLAUDE_SESSION="$(hex 4)-$(hex 2)-4$(hex 2 | cut -c2-4)-8$(hex 2 | cut -c2-4)-$(hex 6)"
  CODEX_SESSION="019ac$(hex 2 | cut -c1-3)-$(hex 2)-7$(hex 2 | cut -c2-4)-8$(hex 2 | cut -c2-4)-$(hex 6)"
  TRANSCRIPT="$TMP/transcripts/$CLAUDE_SESSION.jsonl"
  : >"$TRANSCRIPT"
  CODEX_ROLLOUT="$(codex_rollout)"
  CLAUDE_GENERATIONS=()
  CODEX_TURNS=()

  # --- HAR 1.x: init, full level, connected with an ingest key, repo attached ---------
  log "[$UTAG] HAR $HAR1_VERSION: init, telemetry full, hq connect $([ "$forward" = 1 ] && echo --trajectory || echo --no-trajectory)"
  cp -R "$FIXTURE/project/." "$repo/"
  cd "$repo" || die "no $repo"
  step "[$UTAG] git init" sandbox git init -q -b main
  step "[$UTAG] git remote" sandbox git remote add origin "$repo_url"
  step "[$UTAG] git add" sandbox git add -A
  step "[$UTAG] fixture commit" sandbox git commit -qm "fixture project"
  step "[$UTAG] 1.x env init" sandbox har env init --profile cli --yes --no-agents --no-cursor-rule --commit-gate never
  cp "$FIXTURE"/har-overlay/stages/*.sh .har/stages/
  step "[$UTAG] fixture stages" node "$REPO_ROOT/control/.har/stages/fixture-e2e-assert.mjs" overlay "$FIXTURE/har-overlay/stages.patch.json" .har
  step "[$UTAG] git add harness" sandbox git add -A
  step "[$UTAG] harness commit" sandbox git commit -qm "harness"
  step "[$UTAG] 1.x telemetry full" sandbox har telemetry on --level full
  step "[$UTAG] 1.x hq connect" sandbox har hq connect --portal "$PORTAL_URL" --api-key "$HOSTED_KEY" --repo . --yes \
    "$([ "$forward" = 1 ] && echo --trajectory || echo --no-trajectory)"
  [ -s "$UV/home/.har/portal-targets.json" ] || die "[$UTAG] 1.x saved no connection"
  [ ! -e "$UV/home/.har/destinations/destinations.json" ] || die "[$UTAG] 1.x wrote a destination list"

  # --- the same HOME on 2.0 --------------------------------------------------------------
  log "[$UTAG] switch to 2.0: hooks, one session, verify, commit, complete"
  printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$(command -v node)" "$CLI" >"$UV/bin/har"
  up sandbox har hooks install
  up sandbox har telemetry install-hooks
  # 1.x committed its stage runner into .har/lib/ (no stage-log capture). 2.0
  # runs its packaged runner; maintain removes the stock copy and leaves the
  # project's verification plan alone.
  local plan_before plan_after maintain_problems=()
  plan_before="$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(".har/stages.json","utf8")).verificationStages))')"
  [ -f .har/lib/verify-runner.mjs ] || maintain_problems+=("HAR $HAR1_VERSION committed no .har/lib/verify-runner.mjs")
  up sandbox har env maintain --yes --no-agents --no-cursor-rule --commit-gate never
  plan_after="$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(".har/stages.json","utf8")).verificationStages))')"
  [ "$plan_after" = "$plan_before" ] || maintain_problems+=("verificationStages $plan_before → $plan_after")
  [ ! -e .har/lib/verify-runner.mjs ] || maintain_problems+=("the 1.x .har/lib/verify-runner.mjs is still there")
  grep -q "Removed .har/lib/verify-runner.mjs" "$UV/last.txt" || maintain_problems+=("maintain did not say it removed the runner copy")
  if [ ${#maintain_problems[@]} -eq 0 ]; then
    report PASS "16 [$UTAG] maintain" "stale 1.x .har/lib/verify-runner.mjs removed; verificationStages kept $plan_after"
  else
    report FAIL "16 [$UTAG] maintain" "${maintain_problems[*]}"
  fi
  step "[$UTAG] commit maintain" sandbox git add -A
  step "[$UTAG] commit maintain" sandbox git commit -qm "har env maintain after the 2.0 upgrade"
  up as_claude har env launch 1 --work-id "$work_id" --work-title "Upgrade from 1.x"
  SLOT="$(slot_dir)"
  [ -d "$SLOT" ] || die "[$UTAG] launch left no work dir"
  event hook claude-code SessionStart "$CLAUDE_SESSION" "$SLOT" "transcript=$TRANSCRIPT"
  event hook codex SessionStart "$CODEX_SESSION" "$SLOT" "model=$CODEX_MODEL" "transcript=$CODEX_ROLLOUT"
  up as_codex har env work-bind 1 --work-id "$work_id"
  claude_turn "$SLOT" 120 340 5000 800 40 90 2000
  echo "hello after the upgrade" >"$SLOT/src/greeting.txt"
  codex_turn "$SLOT" t1 12000 8000 1500
  CODEX_TURNS+=('{"input":12000,"cached":8000,"output":1500}')
  up as_claude har env verify 1 --full
  (cd "$SLOT" && up as_claude git add -A && up as_claude git commit -qm "Change the greeting after the upgrade")
  local sha
  sha="$(cd "$SLOT" && sandbox git rev-parse HEAD)"
  up sandbox har env complete 1
  up sandbox har telemetry flush
  sandbox har hq status --json >"$UV/status.json" 2>>"$UOUT" || die "[$UTAG] har hq status --json failed"
  sleep 3

  # --- local state after the upgrade ----------------------------------------------------
  local local_detail
  local_detail="$(node -e '
    const fs = require("fs");
    const [home, out, statusFile, repo, ingest, forward] = process.argv.slice(1);
    const problems = [];
    const notes = [];
    const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    const list = json(`${home}/.har/destinations/destinations.json`).destinations;
    const hq = list.filter((d) => d.preset === "hq");
    if (hq.length !== 1) problems.push(`${hq.length} hq destinations`);
    else {
      const [d] = hq;
      if (!d.enabled || d.baseUrl !== ingest) problems.push(`hq destination ${d.enabled ? "" : "disabled "}at ${d.baseUrl}`);
      if (d.signals.includes("logs") !== (forward === "1")) problems.push(`hq signals ${d.signals.join(",")} with 1.x forwarding ${forward === "1" ? "on" : "off"}`);
      if (!(d.records && d.proofs && d.evidence)) problems.push("hq destination takes no records/proofs/evidence");
      notes.push(`hq destination added (${d.signals.join(", ")})`);
    }
    const text = fs.readFileSync(out, "utf8");
    const notices = (text.match(/\[har\] Added destination "hq"/g) ?? []).length;
    const hints = (text.match(/Full experience: har control trajectory on/g) ?? []).length;
    if (notices !== 1) problems.push(`${notices} migration notices, want 1`);
    if (hints !== (forward === "1" ? 0 : 1)) problems.push(`${hints} full-experience hints, want ${forward === "1" ? 0 : 1}`);
    if (/^\? /m.test(text)) problems.push("a prompt was shown");
    notes.push(`notice once, ${hints} hint`);
    const status = json(statusFile);
    const real = fs.realpathSync(repo);
    const attached = (status.repos ?? []).find((r) => r.repoPath === real || r.repoPath === repo);
    if (!attached || !attached.sendsToHq) problems.push(`repository not attached (${JSON.stringify(status.repos)})`);
    if (status.trajectoryForwarding !== (forward === "1")) problems.push(`hq status trajectoryForwarding ${status.trajectoryForwarding}`);
    notes.push("repository still attached");
    const config = json(`${home}/.har/otel-hooks/otel_config.json`);
    const route = (config.exporter?.destinations ?? []).find((d) => d.name === "hq");
    if (!route) problems.push("otel-hook sends nothing to hq");
    else if (route.signals.includes("logs") !== (forward === "1")) problems.push(`otel-hook hq signals ${route.signals.join(",")}`);
    if (config.exporter?.logs?.includeContent !== true) problems.push("otel-hook does not capture text locally at level full");
    const commands = (file) => Object.values(json(file).hooks ?? {}).flat().flatMap((g) => (g.hooks ?? []).map((h) => h.command)).filter((c) => /run-otel-hook/.test(c ?? ""));
    if (!commands(`${home}/.codex/hooks.json`).every((c) => /--codex-rollout-usage/.test(c))) problems.push("a 1.x Codex hook command was not updated (--codex-rollout-usage)");
    if (!commands(`${home}/.claude/settings.json`).every((c) => /--claude-transcript-usage/.test(c) && /--logs/.test(c) && /--metrics/.test(c))) problems.push("a 1.x Claude Code hook command was not updated");
    notes.push(`otel-hook: hq ${route?.signals.join(",")}, text captured locally, hook flags current`);
    console.log(`${problems.length === 0 ? "PASS" : "FAIL"}\t${problems.length === 0 ? notes.join("; ") : problems.join("; ")}`);
  ' "$UV/home" "$UOUT" "$UV/status.json" "$repo" "$HOSTED_INGEST" "$forward" 2>>"$LOG")" || local_detail=$'FAIL\tlocal state not readable (see the run log)'
  report "${local_detail%%$'\t'*}" "16 [$UTAG] local" "HAR $HAR1_VERSION → 2.0: ${local_detail#*$'\t'}"

  # --- what the receivers got -------------------------------------------------------------
  node -e '
    const [file, repoUrl, workId, claude, codex, collectorDir, sha, tree, message, generations, codexTurns, codexModel,
      mcAdapter, mcRead, mcHeaders, hostedAdapter, hostedRead, hostedHeaders] = process.argv.slice(1);
    const headers = (text) => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
    require("fs").writeFileSync(file, JSON.stringify({
      repoUrl, workId, sessions: { claude_code: claude, codex }, times: {}, collectorDir,
      commits: [{ sha, tree, message }], greetings: ["hello after the upgrade"],
      claudeGenerations: JSON.parse(generations), codexTurns: JSON.parse(codexTurns), codexModel,
      receivers: [
        { name: "mission-control", adapter: mcAdapter, readBase: mcRead, headers: headers(mcHeaders) },
        { name: "hosted", adapter: hostedAdapter, readBase: hostedRead, headers: headers(hostedHeaders) },
      ],
    }, null, 2));
  ' "$TMP/state.json" "$repo_url" "$work_id" "$CLAUDE_SESSION" "$CODEX_SESSION" "$UV/collector" "$sha" \
    "$(cd "$repo" && sandbox git rev-parse "$sha^{tree}")" "$(cd "$repo" && sandbox git log -1 --format=%B "$sha")" \
    "[$(IFS=,; echo "${CLAUDE_GENERATIONS[*]}")]" "[$(IFS=,; echo "${CODEX_TURNS[*]}")]" "$CODEX_MODEL" \
    "$MC_ADAPTER" "$MC_READ" "$("$MC_ADAPTER" read-headers)" "$HOSTED_ADAPTER" "$HOSTED_READ" "$("$HOSTED_ADAPTER" read-headers)" ||
    die "[$UTAG] cannot write the check state"

  local problems=() received usage_detail
  received="$("${CHECKS[@]}" probe-received "$TMP/state.json" hosted "$work_id" "$sha" 2>>"$LOG")" || problems+=("$received")
  [ ${#problems[@]} -eq 0 ] && report PASS "16 [$UTAG] records" "$received" || report FAIL "16 [$UTAG] records" "${problems[*]}"
  # Usage first: once it is there, OTLP from the session has been ingested.
  ucheck usage hosted
  ucheck usage mission-control
  ucheck trajectory mission-control
  if [ "$forward" = 1 ]; then
    ucheck trajectory hosted
  else
    usage_detail="$("${CHECKS[@]}" probe-trajectory "$TMP/state.json" hosted "$CLAUDE_SESSION" 0 2>>"$LOG")" &&
      usage_detail="$usage_detail; $("${CHECKS[@]}" probe-trajectory "$TMP/state.json" hosted "$CODEX_SESSION" 0 2>>"$LOG")" &&
      report PASS "16 [$UTAG] no-trajectory @hosted" "$usage_detail (1.x never forwarded it; Mission Control keeps it locally)" ||
      report FAIL "16 [$UTAG] no-trajectory @hosted" "$usage_detail"
  fi
  cd "$TMP" || true
}

upgrade_variant 0
upgrade_variant 1

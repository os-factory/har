# shellcheck shell=bash
# The 1.x → 2.0 upgrade of a machine logged in to the hosted receiver
# (run.sh --upgrade-from-1x; sourced by run.sh, which provides the receivers,
# the replayed agent turns and the helpers).
#
# In 2.0 the hosted receiver is opt-in per repository: the upgrade logs the user
# out, and only the repositories chosen at the next login are sent, at the chosen
# scope. Twice — scope `usage` (1.x without trajectory forwarding) and scope
# `full` with redacted text (1.x with forwarding): a sandbox HOME where HAR 1.x
# (`@osfactory/har@1`) initialised two repositories, A and B, chose the `full`
# telemetry level and logged in with an ingest key, attaching both. The same HOME
# then runs the 2.0 CLI under test, non-interactively (stdin closed, no TTY).
# Checks:
#   - the first 2.0 command logs out (connection and tokens removed), prints one
#     notice, adds no hq destination; `har hq status` says so; no prompt anywhere;
#   - `har env maintain` removes the 1.x stage-runner copy in .har/lib/ and keeps
#     the project's verificationStages; hook commands carry today's flags;
#   - work in A before the next login (session, verify, commit) never reaches the
#     hosted receiver;
#   - `har hq connect --repo A --scope …` (non-interactive) chooses A only: the hq
#     destination lists A, otel-hook's hq entry is scoped to A's repository;
#   - after it, A's records (run, stages, logs, proof) and usage reach the hosted
#     receiver; its trajectory only at the `full` scope; B (attached in 1.x, not
#     chosen) sends nothing there, while Mission Control (local) holds everything.

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

new_sessions() { # fresh Claude Code and Codex sessions
  CLAUDE_SESSION="$(hex 4)-$(hex 2)-4$(hex 2 | cut -c2-4)-8$(hex 2 | cut -c2-4)-$(hex 6)"
  CODEX_SESSION="019ac$(hex 2 | cut -c1-3)-$(hex 2)-7$(hex 2 | cut -c2-4)-8$(hex 2 | cut -c2-4)-$(hex 6)"
  TRANSCRIPT="$TMP/transcripts/$CLAUDE_SESSION.jsonl"
  : >"$TRANSCRIPT"
  CODEX_ROLLOUT="$(codex_rollout)"
  CLAUDE_GENERATIONS=()
  CODEX_TURNS=()
}

# One unit of agent work in a repository: launch, a Claude Code and a Codex turn,
# full verify, commit, complete. Sets WORK_SHA.
work_in() { # <repo> <work-id> <greeting>
  cd "$1" || die "no $1"
  new_sessions
  up as_claude har env launch 1 --work-id "$2" --work-title "Upgrade from 1.x ($2)"
  SLOT="$(slot_dir)"
  [ -d "$SLOT" ] || die "[$UTAG] launch left no work dir in $1"
  event hook claude-code SessionStart "$CLAUDE_SESSION" "$SLOT" "transcript=$TRANSCRIPT"
  event hook codex SessionStart "$CODEX_SESSION" "$SLOT" "model=$CODEX_MODEL" "transcript=$CODEX_ROLLOUT"
  up as_codex har env work-bind 1 --work-id "$2"
  claude_turn "$SLOT" 120 340 5000 800 40 90 2000
  echo "$3" >"$SLOT/src/greeting.txt"
  codex_turn "$SLOT" t1 12000 8000 1500
  CODEX_TURNS+=('{"input":12000,"cached":8000,"output":1500}')
  up as_claude har env verify 1 --full
  (cd "$SLOT" && up as_claude git add -A && up as_claude git commit -qm "$3")
  WORK_SHA="$(cd "$SLOT" && sandbox git rev-parse HEAD)"
  up sandbox har env complete 1
  up sandbox har telemetry flush
}

write_state() { # <file> <repo> <repo-url> <work-id> <sha> <greeting>
  node -e '
    const [file, repoUrl, workId, claude, codex, collectorDir, sha, tree, message, greeting, generations, codexTurns, codexModel,
      mcAdapter, mcRead, mcHeaders, hostedAdapter, hostedRead, hostedHeaders] = process.argv.slice(1);
    const headers = (text) => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
    require("fs").writeFileSync(file, JSON.stringify({
      repoUrl, workId, sessions: { claude_code: claude, codex }, times: {}, collectorDir,
      commits: [{ sha, tree, message }], greetings: [greeting],
      claudeGenerations: JSON.parse(generations), codexTurns: JSON.parse(codexTurns), codexModel,
      receivers: [
        { name: "mission-control", adapter: mcAdapter, readBase: mcRead, headers: headers(mcHeaders) },
        { name: "hosted", adapter: hostedAdapter, readBase: hostedRead, headers: headers(hostedHeaders) },
      ],
    }, null, 2));
  ' "$1" "$3" "$4" "$CLAUDE_SESSION" "$CODEX_SESSION" "$UV/collector" "$5" \
    "$(cd "$2" && sandbox git rev-parse "$5^{tree}")" "$(cd "$2" && sandbox git log -1 --format=%B "$5")" "$6" \
    "[$(IFS=,; echo "${CLAUDE_GENERATIONS[*]}")]" "[$(IFS=,; echo "${CODEX_TURNS[*]}")]" "$CODEX_MODEL" \
    "$MC_ADAPTER" "$MC_READ" "$("$MC_ADAPTER" read-headers)" "$HOSTED_ADAPTER" "$HOSTED_READ" "$("$HOSTED_ADAPTER" read-headers)" ||
    die "[$UTAG] cannot write the check state $1"
}

upgrade_variant() { # <usage|full>: the scope chosen at the next login (1.x forwarding off / on)
  local scope=$1 forward content_flags=()
  [ "$scope" = full ] && forward=1 || forward=0
  [ "$scope" = full ] && content_flags=(--content redacted)
  UTAG="upgrade-from-1x scope-$scope${content_flags[1]:+-${content_flags[1]}}"
  UV="$TMP/upgrade-$scope"
  UOUT="$UV/v2-output.txt"
  local repo_a="$UV/repo-a" repo_b="$UV/repo-b"
  local url_a="https://example.test/har-local-stack/$RUN_TAG-upgrade-$scope-a.git"
  local url_b="https://example.test/har-local-stack/$RUN_TAG-upgrade-$scope-b.git"
  mkdir -p "$UV"/{home,bin,repo-a,repo-b,collector}
  : >"$UOUT"
  cp "$TMP/bin/docker" "$UV/bin/docker"
  ln -s "$GIT_FACTORY" "$UV/bin/git-factory"
  printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$(command -v node)" "$HAR1_CLI" >"$UV/bin/har"
  chmod +x "$UV/bin/har"
  # The run's sandbox, on this variant's HOME, with no hosted receiver env:
  # 2.0 must find (and remove) the login 1.x saved. stdin closed: nothing can prompt.
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

  # --- HAR 1.x: two repositories, telemetry full, logged in, both attached ---------------
  log "[$UTAG] HAR $HAR1_VERSION: init A and B, telemetry full, hq connect $([ "$forward" = 1 ] && echo --trajectory || echo --no-trajectory)"
  local repo url
  for repo in "$repo_a" "$repo_b"; do
    [ "$repo" = "$repo_a" ] && url="$url_a" || url="$url_b"
    cp -R "$FIXTURE/project/." "$repo/"
    cd "$repo" || die "no $repo"
    step "[$UTAG] git init" sandbox git init -q -b main
    step "[$UTAG] git remote" sandbox git remote add origin "$url"
    step "[$UTAG] git add" sandbox git add -A
    step "[$UTAG] fixture commit" sandbox git commit -qm "fixture project"
    step "[$UTAG] 1.x env init" sandbox har env init --profile cli --yes --no-agents --no-cursor-rule --commit-gate never
    cp "$FIXTURE"/har-overlay/stages/*.sh .har/stages/
    step "[$UTAG] fixture stages" node "$REPO_ROOT/control/.har/stages/fixture-e2e-assert.mjs" overlay "$FIXTURE/har-overlay/stages.patch.json" .har
    step "[$UTAG] git add harness" sandbox git add -A
    step "[$UTAG] harness commit" sandbox git commit -qm "harness"
  done
  cd "$repo_a" || die "no $repo_a"
  step "[$UTAG] 1.x telemetry full" sandbox har telemetry on --level full
  for repo in "$repo_a" "$repo_b"; do
    step "[$UTAG] 1.x hq connect" sandbox har hq connect --portal "$PORTAL_URL" --api-key "$HOSTED_KEY" --repo "$repo" --yes \
      "$([ "$forward" = 1 ] && echo --trajectory || echo --no-trajectory)"
  done
  [ -s "$UV/home/.har/portal-targets.json" ] || die "[$UTAG] 1.x saved no connection"
  [ ! -e "$UV/home/.har/destinations/destinations.json" ] || die "[$UTAG] 1.x wrote a destination list"

  # --- the same HOME on 2.0: logged out --------------------------------------------------
  log "[$UTAG] switch to 2.0: logged out, maintain, work in A before the next login"
  printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$(command -v node)" "$CLI" >"$UV/bin/har"
  up sandbox har hooks install
  (cd "$repo_b" && up sandbox har hooks install) || die "[$UTAG] hooks install in B failed"
  up sandbox har telemetry install-hooks
  sandbox har hq status --json >"$UV/status-logged-out.json" 2>>"$UOUT" || die "[$UTAG] har hq status --json failed"
  local logout_detail
  logout_detail="$(node -e '
    const fs = require("fs");
    const [home, out, statusFile, forward] = process.argv.slice(1);
    const problems = [];
    const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    const text = fs.readFileSync(out, "utf8");
    const notices = (text.match(/HAR 2\.0 sends to HAR HQ only for repositories you choose\. Run `har hq connect` to log in again\./g) ?? []).length;
    if (notices !== 1) problems.push(`${notices} logout notices, want 1`);
    const targets = fs.existsSync(`${home}/.har/portal-targets.json`) ? json(`${home}/.har/portal-targets.json`) : { targets: [] };
    if ((targets.targets ?? []).length > 0) problems.push("the 1.x connection is still stored");
    if (fs.existsSync(`${home}/.har/credentials.json`)) problems.push("the 1.x credentials.json is still there");
    const list = fs.existsSync(`${home}/.har/destinations/destinations.json`) ? json(`${home}/.har/destinations/destinations.json`).destinations : [];
    if (list.some((d) => d.preset === "hq")) problems.push("an hq destination was added");
    const migration = json(`${home}/.har/destinations/migrations.json`).migrations["hq-logout-2-0"];
    if (migration?.result !== "logged-out") problems.push(`migration ${JSON.stringify(migration)}`);
    if ((migration?.defaults?.repositories ?? []).length !== 2) problems.push("the 1.x attachments were not kept as defaults");
    if (migration?.defaults?.trajectoryForwarding !== (forward === "1")) problems.push("the 1.x trajectory choice was not kept");
    const status = json(statusFile);
    if (status.connection !== null) problems.push("har hq status still shows a connection");
    if (!/Logged out of HAR HQ by the upgrade/.test(status.hint ?? "")) problems.push(`har hq status hint ${JSON.stringify(status.hint)}`);
    const config = json(`${home}/.har/otel-hooks/otel_config.json`);
    if ((config.exporter?.destinations ?? []).some((d) => d.name === "hq")) problems.push("otel-hook sends to hq");
    const commands = (file) => Object.values(json(file).hooks ?? {}).flat().flatMap((g) => (g.hooks ?? []).map((h) => h.command)).filter((c) => /run-otel-hook/.test(c ?? ""));
    if (!commands(`${home}/.codex/hooks.json`).every((c) => /--codex-rollout-usage/.test(c))) problems.push("a 1.x Codex hook command was not updated");
    if (!commands(`${home}/.claude/settings.json`).every((c) => /--claude-transcript-usage/.test(c) && /--logs/.test(c) && /--metrics/.test(c))) problems.push("a 1.x Claude Code hook command was not updated");
    console.log(`${problems.length === 0 ? "PASS" : "FAIL"}\t${problems.length === 0 ? "one logout notice; connection and tokens removed; no hq destination; status says logged out; 1.x choices kept as defaults; hook flags current" : problems.join("; ")}`);
  ' "$UV/home" "$UOUT" "$UV/status-logged-out.json" "$forward" 2>>"$LOG")" || logout_detail=$'FAIL\tlocal state not readable (see the run log)'
  report "${logout_detail%%$'\t'*}" "16 [$UTAG] logout" "HAR $HAR1_VERSION → 2.0: ${logout_detail#*$'\t'}"

  # 1.x committed its stage runner into .har/lib/ (no stage-log capture). 2.0
  # runs its packaged runner; maintain removes the stock copy and leaves the
  # project's verification plan alone.
  cd "$repo_a" || die "no $repo_a"
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

  # Work in A while logged out: none of it may ever reach the hosted receiver.
  work_in "$repo_a" "pre-$scope" "hello while logged out"
  local pre_sessions=("$CLAUDE_SESSION" "$CODEX_SESSION") pre_sha=$WORK_SHA

  # --- the next login, non-interactive: A only -----------------------------------------
  log "[$UTAG] har hq connect --repo A --scope $scope ${content_flags[*]}"
  cd "$repo_a" || die "no $repo_a"
  up sandbox har hq connect --portal "$PORTAL_URL" --api-key "$HOSTED_KEY" --repo "$repo_a" --scope "$scope" "${content_flags[@]}" --yes
  cp "$UV/last.txt" "$UV/connect-output.txt"
  local connect_detail
  connect_detail="$(node -e '
    const fs = require("fs");
    const [home, out, repoA, urlA, scope, content] = process.argv.slice(1);
    const problems = [];
    const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    const text = fs.readFileSync(out, "utf8");
    if (/^\? /m.test(text)) problems.push("a prompt was shown");
    const hq = json(`${home}/.har/destinations/destinations.json`).destinations.filter((d) => d.preset === "hq");
    const real = fs.realpathSync(repoA);
    if (hq.length !== 1) problems.push(`${hq.length} hq destinations`);
    const repos = hq[0]?.repositories ?? [];
    if (repos.length !== 1 || repos[0].path !== real || repos[0].scope !== scope || (scope === "full" && repos[0].content !== content))
      problems.push(`hq repositories ${JSON.stringify(repos)}`);
    const key = urlA.replace(/^https:\/\//, "").replace(/\.git$/, "").toLowerCase();
    const config = json(`${home}/.har/otel-hooks/otel_config.json`);
    const route = (config.exporter?.destinations ?? []).find((d) => d.name === "hq");
    const want = scope === "usage" ? { signals: ["traces", "metrics"], contentMode: "omit" } : { signals: ["traces", "logs", "metrics"], contentMode: content === "redacted" ? "redact" : content };
    if (!route) problems.push("otel-hook sends nothing to hq (an otel-hook without destination scopes?)");
    else if (JSON.stringify(route.scopes) !== JSON.stringify([{ repositories: [key], ...want }])) problems.push(`otel-hook hq scopes ${JSON.stringify(route.scopes)}`);
    const mc = (config.exporter?.destinations ?? []).find((d) => d.name === "mission-control");
    if (!mc || mc.scopes) problems.push("Mission Control is missing or scoped");
    if (config.privacy?.contentMode !== "raw") problems.push(`global content mode ${config.privacy?.contentMode}: Mission Control must keep the text`);
    console.log(`${problems.length === 0 ? "PASS" : "FAIL"}\t${problems.length === 0 ? `no prompt; hq lists A only (${scope}${scope === "full" ? `, ${content}` : ""}); otel-hook hq scope ${JSON.stringify(route.scopes[0])}; Mission Control unscoped, raw` : problems.join("; ")}`);
  ' "$UV/home" "$UV/connect-output.txt" "$repo_a" "$url_a" "$scope" "${content_flags[1]:-none}" 2>>"$LOG")" || connect_detail=$'FAIL\tlocal state not readable (see the run log)'
  report "${connect_detail%%$'\t'*}" "16 [$UTAG] connect" "${connect_detail#*$'\t'}"

  # --- after the login: work in A (chosen) and in B (not chosen) -------------------------
  work_in "$repo_b" "b-$scope" "hello from B"
  local b_sessions=("$CLAUDE_SESSION" "$CODEX_SESSION") b_sha=$WORK_SHA
  write_state "$UV/state-b.json" "$repo_b" "$url_b" "b-$scope" "$b_sha" "hello from B"
  work_in "$repo_a" "a-$scope" "hello after the login"
  local a_sha=$WORK_SHA
  write_state "$TMP/state.json" "$repo_a" "$url_a" "a-$scope" "$a_sha" "hello after the login"
  sleep 3

  # --- what the receivers got -------------------------------------------------------------
  local received detail
  received="$("${CHECKS[@]}" probe-received "$TMP/state.json" hosted "a-$scope" "$a_sha" 2>>"$LOG")" &&
    report PASS "16 [$UTAG] records" "$received" || report FAIL "16 [$UTAG] records" "$received"
  # Usage first: once it is there, OTLP from A's sessions has been ingested.
  ucheck usage hosted
  ucheck usage mission-control
  ucheck trajectory mission-control
  if [ "$scope" = full ]; then
    ucheck trajectory hosted
  else
    detail="$("${CHECKS[@]}" probe-trajectory "$TMP/state.json" hosted "$CLAUDE_SESSION" 0 2>>"$LOG")" &&
      detail="$detail; $("${CHECKS[@]}" probe-trajectory "$TMP/state.json" hosted "$CODEX_SESSION" 0 2>>"$LOG")" &&
      report PASS "16 [$UTAG] no-trajectory @hosted" "$detail (scope usage; Mission Control keeps it locally)" ||
      report FAIL "16 [$UTAG] no-trajectory @hosted" "$detail"
  fi
  # Nothing of what was not chosen: A before the login, and B.
  detail="$("${CHECKS[@]}" probe-nothing "$TMP/state.json" hosted "$url_a" "pre-$scope" "${pre_sessions[@]}" 2>>"$LOG")" &&
    report PASS "16 [$UTAG] logged-out @hosted" "$detail (commit ${pre_sha:0:8}, before the login)" ||
    report FAIL "16 [$UTAG] logged-out @hosted" "$detail"
  detail="$("${CHECKS[@]}" probe-nothing "$UV/state-b.json" hosted "$url_b" "b-$scope" "${b_sessions[@]}" 2>>"$LOG")" &&
    report PASS "16 [$UTAG] not-chosen @hosted" "$detail (B was attached in 1.x)" ||
    report FAIL "16 [$UTAG] not-chosen @hosted" "$detail"
  detail="$("${CHECKS[@]}" probe-received "$UV/state-b.json" mission-control "b-$scope" "$b_sha" 2>>"$LOG")" &&
    report PASS "16 [$UTAG] not-chosen @mission-control" "$detail (Mission Control is not scoped)" ||
    report FAIL "16 [$UTAG] not-chosen @mission-control" "$detail"
  cd "$TMP" || true
}

upgrade_variant usage
upgrade_variant full

#!/usr/bin/env bash
# Local stack end to end: the HAR CLI, otel-hook, Mission Control, a hosted
# receiver and an OpenTelemetry Collector, together, from a clean state.
# ADR 0004 and ADR 0005 are done when every check here passes. See README.md.
#
# Prints one `PASS <check>: <detail>` or `FAIL <check>: <detail>` line per check
# on stdout (progress goes to stderr, command output to the run log) and exits
# non-zero when any check fails.
#
# --real-agents (or HAR_E2E_REAL_AGENTS=1): real Claude Code and Codex sessions
# calling real models replace the replayed hook events (lib/real-agents.sh).
# --upgrade-from-1x: only the 1.x → 2.0 upgrade of a machine connected to the
# hosted receiver, with and without 1.x trajectory forwarding (lib/upgrade-from-1x.sh).
set -uo pipefail

REAL_AGENTS="${HAR_E2E_REAL_AGENTS:-0}"
UPGRADE=0
for arg in "$@"; do
  case "$arg" in
    --real-agents) REAL_AGENTS=1 ;;
    --upgrade-from-1x) UPGRADE=1 ;;
    *) echo "usage: $0 [--real-agents | --upgrade-from-1x]" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$HERE/lib"
CHECKS=(node "$LIB/checks.mjs")

# --- configuration -----------------------------------------------------------
CLI="${HAR_E2E_CLI:-$REPO_ROOT/dist/index.js}"
MC_ADAPTER="${HAR_E2E_MC_ADAPTER:-$HERE/adapters/mission-control.sh}"
HOSTED_ADAPTER="${HAR_E2E_HOSTED_ADAPTER:-}"
OTEL_HOOK_PACKAGE="${HAR_E2E_OTEL_HOOK_PACKAGE:-}"
COLLECTOR_IMAGE="${HAR_E2E_COLLECTOR_IMAGE:-otel/opentelemetry-collector-contrib:0.139.0}"
HAR1_CLI="${HAR_E2E_HAR1_CLI:-}"
GIT_FACTORY="${HAR_E2E_GIT_FACTORY:-$(command -v git-factory || true)}"
FIXTURE="$REPO_ROOT/tests/fixtures/fixture-e2e"
CODEX_MODEL="${HAR_E2E_CODEX_MODEL:-gpt-5}"
CLAUDE_MODEL="${HAR_E2E_CLAUDE_MODEL:-claude-sonnet-4-5}"
CLAUDE_SUBAGENT_MODEL="${HAR_E2E_CLAUDE_SUBAGENT_MODEL:-claude-haiku-4-5}"

RUN_TAG="$(date -u +%Y%m%d%H%M%S)-$$"
TMP="$(mktemp -d "${HAR_E2E_TMPDIR:-${TMPDIR:-/tmp}}/har-local-stack.XXXXXX")"
LOG="$TMP/run.log"
REPO="$TMP/repo"
REPO_URL="https://example.test/har-local-stack/$RUN_TAG.git"
WORK_ID="e2e-1"
WORK_ID_B="e2e-2"
# Real-looking session ids (a Claude Code UUID, a Codex UUIDv7), unique per run:
# receivers key usage and running totals by session, so a fixed id would merge runs.
hex() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"; }
CLAUDE_SESSION="$(hex 4)-$(hex 2)-4$(hex 2 | cut -c2-4)-8$(hex 2 | cut -c2-4)-$(hex 6)"
CODEX_SESSION="019ac$(hex 2 | cut -c1-3)-$(hex 2)-7$(hex 2 | cut -c2-4)-8$(hex 2 | cut -c2-4)-$(hex 6)"

FAILS=0
COLLECTOR_NAME=""
PIDS=()
CREDENTIAL_FILES=()

log() { echo "==> $*" >&2; }
report() { # PASS|FAIL <check> <detail>
  echo "$1 $2: $3"
  [ "$1" = PASS ] || FAILS=$((FAILS + 1))
}
check() { # checks.mjs <command> [target]
  local line
  line="$("${CHECKS[@]}" "$1" "$TMP/state.json" "${@:2}" 2>>"$LOG")" || line="FAIL $1${2:+ @$2}: checks.mjs crashed (see $LOG)"
  echo "$line"
  case "$line" in PASS* | SKIP*) ;; *) FAILS=$((FAILS + 1)) ;; esac
}
die() {
  report FAIL "0 setup" "$* (log: $LOG)"
  exit 1
}

cleanup() {
  local code=$?
  for file in "${CREDENTIAL_FILES[@]}"; do rm -f "$file"; done
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  [ -n "$COLLECTOR_NAME" ] && docker rm -f "$COLLECTOR_NAME" >/dev/null 2>&1
  # A stopped receiver is never left behind.
  [ -n "${MC_STOPPED:-}" ] && "$MC_ADAPTER" start >>"$LOG" 2>&1
  [ -n "${HOSTED_STOPPED:-}" ] && "$HOSTED_ADAPTER" start >>"$LOG" 2>&1
  if [ "${HAR_E2E_KEEP:-0}" = "1" ]; then
    log "kept $TMP"
  else
    rm -rf "$TMP"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$TMP"/{home,bin,repo,collector,transcripts,v1/home,v1/bin}
chmod 0777 "$TMP/collector"
log "run $RUN_TAG in $TMP (log $LOG)"

# --- preflight ------------------------------------------------------------------
[ -f "$CLI" ] || die "no CLI at $CLI (npm run build)"
[ -d "$FIXTURE/project" ] || die "missing fixture $FIXTURE"
# The hosted receiver is optional: without an adapter, its checks are skipped.
HOSTED_ON=0
if [ -n "$HOSTED_ADAPTER" ]; then
  [ -x "$HOSTED_ADAPTER" ] || die "HAR_E2E_HOSTED_ADAPTER is not an executable adapter"
  HOSTED_ON=1
fi
RECEIVERS=(mission-control)
[ $HOSTED_ON = 1 ] && RECEIVERS+=(hosted)
[ -n "$OTEL_HOOK_PACKAGE" ] || die "HAR_E2E_OTEL_HOOK_PACKAGE is not set (an otel-hook build with the session-context step)"
[ -n "$GIT_FACTORY" ] && [ -x "$GIT_FACTORY" ] || die "git-factory not found (HAR_E2E_GIT_FACTORY)"
[ "$UPGRADE" = 0 ] || [ $HOSTED_ON = 1 ] || die "--upgrade-from-1x needs the hosted receiver (HAR_E2E_HOSTED_ADAPTER)"
REAL_DOCKER="$(command -v docker)" || die "docker is required for the collector"

describe() { "$1" describe | sed -n "s/^$2=//p"; }
MC_INGEST="$(describe "$MC_ADAPTER" INGEST_BASE)" || die "Mission Control adapter: describe failed"
MC_READ="$(describe "$MC_ADAPTER" READ_BASE)"
MC_URL="${MC_INGEST%/api}"
HOSTED_INGEST="" HOSTED_READ="" HOSTED_KEY=""
if [ $HOSTED_ON = 1 ]; then
  "$HOSTED_ADAPTER" setup >>"$LOG" 2>&1 || die "hosted adapter: setup failed"
  HOSTED_INGEST="$(describe "$HOSTED_ADAPTER" INGEST_BASE)"
  HOSTED_READ="$(describe "$HOSTED_ADAPTER" READ_BASE)"
  HOSTED_KEY="$("$HOSTED_ADAPTER" ingest-key)"
fi
curl -sf "$MC_INGEST/v2/capabilities" >/dev/null || die "no ingest v2 receiver at $MC_INGEST"
if [ $HOSTED_ON = 1 ]; then
  curl -sf -H "Authorization: Bearer $HOSTED_KEY" "$HOSTED_INGEST/v2/capabilities" >/dev/null || die "no ingest v2 receiver at $HOSTED_INGEST"
fi
# HAR_E2E_RECORD_HOSTED=1: the CLI and otel-hook send to the hosted receiver through
# a recording proxy; every exchange (and the body of every non-2xx reply) goes to
# $TMP/hosted-exchanges.jsonl.
HOSTED_SEND="$HOSTED_INGEST"
if [ $HOSTED_ON = 1 ] && [ "${HAR_E2E_RECORD_HOSTED:-0}" = "1" ]; then
  node "$LIB/recording-proxy.mjs" "$TMP/hosted-proxy.port" "$TMP/hosted-exchanges.jsonl" "$HOSTED_INGEST" >>"$LOG" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 50); do [ -s "$TMP/hosted-proxy.port" ] && break; sleep 0.1; done
  HOSTED_SEND="http://127.0.0.1:$(cat "$TMP/hosted-proxy.port")"
fi

# --- the OpenTelemetry Collector (OTLP/HTTP in, one JSON file per signal out) ----
if [ "$UPGRADE" = 0 ]; then
COLLECTOR_PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
COLLECTOR_NAME="har-e2e-collector-$RUN_TAG"
cat >"$TMP/collector.yaml" <<'YAML'
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file/traces: { path: /out/traces.jsonl, flush_interval: 200ms }
  file/logs: { path: /out/logs.jsonl, flush_interval: 200ms }
  file/metrics: { path: /out/metrics.jsonl, flush_interval: 200ms }
service:
  telemetry: { logs: { level: warn } }
  pipelines:
    traces: { receivers: [otlp], exporters: [file/traces] }
    logs: { receivers: [otlp], exporters: [file/logs] }
    metrics: { receivers: [otlp], exporters: [file/metrics] }
YAML
log "collector $COLLECTOR_IMAGE on 127.0.0.1:$COLLECTOR_PORT"
docker run -d --name "$COLLECTOR_NAME" --user "$(id -u):$(id -g)" -p "127.0.0.1:$COLLECTOR_PORT:4318" \
  -v "$TMP/collector.yaml:/etc/otelcol.yaml:ro" -v "$TMP/collector:/out" \
  "$COLLECTOR_IMAGE" --config /etc/otelcol.yaml >>"$LOG" 2>&1 || die "collector did not start"
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$COLLECTOR_PORT/v1/traces")"
  [ "$code" = 200 ] && break
  sleep 1
done
[ "${code:-}" = 200 ] || die "collector does not answer on 127.0.0.1:$COLLECTOR_PORT"
fi

# --- the sandbox: HOME, PATH, HAR state under $TMP; nothing touches the real ones --
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$(command -v node)" "$CLI" >"$TMP/bin/har"
ln -s "$GIT_FACTORY" "$TMP/bin/git-factory"
# The CLI must never manage a shared Mission Control container from here: only
# read-only docker commands get through.
cat >"$TMP/bin/docker" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  ps | inspect | version | info | images) exec "$REAL_DOCKER" "\$@" ;;
  *) echo "docker \$1: refused in the e2e sandbox" >&2; exit 1 ;;
esac
EOF
cp "$TMP/bin/docker" "$TMP/v1/bin/docker"
chmod +x "$TMP/bin/har" "$TMP/bin/docker" "$TMP/v1/bin/docker"

sandbox() {
  env -i \
    PATH="$TMP/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" \
    HOME="$TMP/home" TMPDIR="$TMP" TERM=dumb \
    HAR_CONTROL_API_URL="$MC_URL" \
    HAR_DESTINATIONS_DIR="$TMP/destinations" \
    HAR_INGEST_QUEUE_DIR="$TMP/queue" \
    HAR_SESSIONS_DIR="$TMP/sessions" \
    HAR_OTEL_HOOKS_PACKAGE="$OTEL_HOOK_PACKAGE" \
    HAR_PORTAL_URL="${HOSTED_INGEST%/ingest}" HAR_PORTAL_TOKEN="$HOSTED_KEY" \
    GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test \
    GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test \
    "$@"
}
as_claude() { sandbox CLAUDE_CODE_SESSION_ID="$CLAUDE_SESSION" "$@"; }
as_codex() { sandbox CODEX_THREAD_ID="$CODEX_SESSION" "$@"; }
step() { # <description> <command...>: run, log, die on failure
  local what=$1
  shift
  echo "### $what" >>"$LOG"
  "$@" >>"$LOG" 2>&1 || die "$what failed"
}
# Sends what is queued; exits non-zero while a receiver is down, which is expected here.
flush() {
  echo "### har telemetry flush" >>"$LOG"
  sandbox har telemetry flush >>"$LOG" 2>&1 || true
}
# Mission Control in a HAR slot runs `next dev`: a route left idle is compiled
# again on its next request (1-2 s), past otel-hook's 1.5 s export budget, and
# otel-hook then treats it as down for 30 s and spools what it sends there (to
# drain on a later hook, after the replay is over). Keep its OTLP routes warm
# while agent events are replayed; a production Mission Control answers at once.
MC_WARM_AT=0
warm_mission_control() {
  local t
  t=$(date +%s)
  [ $((t - MC_WARM_AT)) -lt 20 ] && return 0
  for signal in traces logs metrics; do
    curl -s -o /dev/null -m 15 -X POST -H 'content-type: application/json' -d '{}' "$MC_URL/api/otel/v1/$signal" || true
  done
  MC_WARM_AT=$t
}
# Waits (at most 60 s) until no receiver is inside otel-hook's down window.
wait_otel_hook_down_windows() {
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    const until = () => {
      let latest = 0;
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        try { latest = Math.max(latest, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).downUntil ?? 0); } catch {}
      }
      return latest;
    };
    const deadline = Date.now() + 60000;
    const tick = () => (until() < Date.now() || Date.now() > deadline ? process.exit(0) : setTimeout(tick, 500));
    tick();
  ' "$TMP/home/.har/otel-hooks/state/endpoint-health"
}
event() {
  warm_mission_control
  sandbox node "$LIB/events.mjs" "$@" >>"$LOG" 2>&1 || die "agent event $* failed"
}
now() { node -e 'console.log(new Date().toISOString())'; }
segment_time() { # <tool dir> <session> <from|to> [index]: a segment time from the session context
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const s = c.segments.at(Number(process.argv[3] ?? -1));
    process.stdout.write(String(s?.[process.argv[2]] ?? ""));
  ' "$TMP/sessions/$1/$2.json" "$3" "${4:--1}"
}
queue_pending() { find "$TMP/queue/$1" -maxdepth 1 -name '*.json' ! -name state.json 2>/dev/null | wc -l; }
slot_dir() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".har/slots/agent-1.json","utf8")).workDir)'; }

# --- replayed agent turns, verify and commit -----------------------------------------
TRANSCRIPT="$TMP/transcripts/$CLAUDE_SESSION.jsonl"
: >"$TRANSCRIPT"
CLAUDE_GENERATIONS=()
# One Claude Code turn: an edit, then an Explore subagent that reads a file. Two
# generations, each with its own tokens: the turn's (main model) at Stop and the
# subagent's (its model) at SubagentStop.
claude_turn() { # <cwd> <input> <output> <cache-read> <cache-creation> <subagent input> <subagent output> <subagent cache-read>
  local agent="a$(hex 8)" edit="toolu_$(hex 8)" task="toolu_$(hex 8)" read="toolu_$(hex 8)"
  local agent_transcript="$TMP/transcripts/$CLAUDE_SESSION/subagents/agent-$agent.jsonl"
  event hook claude-code UserPromptSubmit "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT"
  event hook claude-code PreToolUse "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" "call=$edit"
  event hook claude-code PostToolUse "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" "call=$edit"
  event hook claude-code PreToolUse "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" tool=Agent "call=$task" agent_type=Explore
  event hook claude-code SubagentStart "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" "agent=$agent" agent_type=Explore
  event hook claude-code PreToolUse "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" tool=Read "call=$read" "agent=$agent" agent_type=Explore
  event hook claude-code PostToolUse "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" tool=Read "call=$read" "agent=$agent" agent_type=Explore
  event transcript "$agent_transcript" "$CLAUDE_SESSION" "$CLAUDE_SUBAGENT_MODEL" "$6" "$7" "$8" 0 "$agent"
  event hook claude-code SubagentStop "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" "agent=$agent" agent_type=Explore "agent_transcript=$agent_transcript"
  event hook claude-code PostToolUse "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT" tool=Agent "call=$task" agent_type=Explore
  event transcript "$TRANSCRIPT" "$CLAUDE_SESSION" "$CLAUDE_MODEL" "$2" "$3" "$4" "$5"
  event hook claude-code Stop "$CLAUDE_SESSION" "$1" "transcript=$TRANSCRIPT"
  CLAUDE_GENERATIONS+=("{\"model\":\"$CLAUDE_MODEL\",\"input\":$2,\"output\":$3,\"cacheRead\":$4,\"cacheCreation\":$5}")
  CLAUDE_GENERATIONS+=("{\"model\":\"$CLAUDE_SUBAGENT_MODEL\",\"input\":$6,\"output\":$7,\"cacheRead\":$8,\"cacheCreation\":0,\"subagent\":\"$agent\"}")
}
CODEX_TURNS=()
# Codex's Stop hook carries no usage: otel-hook reads the session's running
# totals from the rollout the hooks name (--codex-rollout-usage on HAR's command).
codex_rollout() { echo "$TMP/codex/sessions/$(date +%Y/%m/%d)/rollout-$RUN_TAG-$CODEX_SESSION.jsonl"; }
CODEX_ROLLOUT="$(codex_rollout)"
codex_turn() { # <cwd> <turn> <input> <cached> <output>   (session running totals, as Codex reports them)
  event hook codex UserPromptSubmit "$CODEX_SESSION" "$1" "turn=$2" "transcript=$CODEX_ROLLOUT"
  sandbox node "$LIB/events.mjs" rollout "$CODEX_ROLLOUT" "$CODEX_SESSION" "$CODEX_MODEL" "$3" "$4" "$5" >>"$LOG" 2>&1 || die "codex rollout failed"
  event hook codex Stop "$CODEX_SESSION" "$1" "turn=$2" "model=$CODEX_MODEL" "transcript=$CODEX_ROLLOUT"
}

COMMITS=()
verify_and_commit() { # <message> <as-function>
  log "har env verify 1 --full; git commit \"$1\""
  step "verify ($1)" "$2" har env verify 1 --full
  (cd "$SLOT" && "$2" git add -A && "$2" git commit -qm "$1") >>"$LOG" 2>&1 || die "commit \"$1\" failed"
  COMMITS+=("$(cd "$SLOT" && sandbox git rev-parse HEAD)")
}

if [ "$UPGRADE" = 1 ]; then
  # shellcheck source=lib/upgrade-from-1x.sh
  . "$LIB/upgrade-from-1x.sh"
  log "done: $FAILS failing check(s)"
  [ "$FAILS" -eq 0 ]
  exit
fi

# --- the fixture repository ---------------------------------------------------------
log "fixture repository $REPO_URL"
cp -R "$FIXTURE/project/." "$REPO/"
cd "$REPO" || die "no $REPO"
step "git init" sandbox git init -q -b main
step "git remote" sandbox git remote add origin "$REPO_URL"
step "git add" sandbox git add -A
step "fixture commit" sandbox git commit -qm "fixture project"
step "har env init" sandbox har env init --profile cli --yes --no-agents --no-cursor-rule --commit-gate never
cp "$FIXTURE"/har-overlay/stages/*.sh .har/stages/
step "fixture stages" node "$REPO_ROOT/control/.har/stages/fixture-e2e-assert.mjs" overlay "$FIXTURE/har-overlay/stages.patch.json" .har
step "git add harness" sandbox git add -A
step "harness commit" sandbox git commit -qm "harness"
step "har hooks install" sandbox har hooks install

log "destinations: Mission Control (implicit), hosted receiver, collector, git notes"
if [ $HOSTED_ON = 1 ]; then
  # The full experience: the hosted receiver takes the trajectory (logs) too.
  step "trajectory forwarding" sandbox har control trajectory on
  # The first command already added an hq destination for the key in the
  # environment (the 1.x → 2.0 migration); this one sets where it sends.
  step "destination hq" sandbox har telemetry destination add hq --preset hq --base-url "$HOSTED_SEND" --overwrite
fi
step "destination collector" sandbox har telemetry destination add collector --preset otlp \
  --endpoint "http://127.0.0.1:$COLLECTOR_PORT" --signals traces,logs,metrics
step "destination git notes" sandbox har telemetry destination add notes --preset git-notes
step "otel-hook install" sandbox har telemetry install-hooks
[ -x "$TMP/home/.har/otel-hooks/run-otel-hook.sh" ] || die "otel-hook wrapper missing after install-hooks"
grep -q '"sessionContext"' "$TMP/home/.har/otel-hooks/otel_config.json" || die "otel-hook config has no sessionContext (otel-hook too old?)"
# Claude Code usage and trajectory come from otel-hook only: HAR registers its
# hook with transcript usage, logs and metrics, and turns no native telemetry on.
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const commands = Object.values(s.hooks ?? {}).flat().flatMap((g) => (g.hooks ?? []).map((h) => h.command)).filter((c) => /run-otel-hook/.test(c ?? ""));
  if (commands.length === 0 || !commands.every((c) => /--claude-transcript-usage/.test(c) && /--logs/.test(c) && /--metrics/.test(c))) process.exit(1);
  if (s.env?.CLAUDE_CODE_ENABLE_TELEMETRY) process.exit(2);
' "$TMP/home/.claude/settings.json" || die "Claude Code hook not registered with --claude-transcript-usage --logs --metrics, or native telemetry on"
# Codex's Stop hook reports no tokens: HAR registers its hook with --codex-rollout-usage.
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const commands = Object.values(s.hooks ?? {}).flat().flatMap((g) => (g.hooks ?? []).map((h) => h.command)).filter((c) => /run-otel-hook/.test(c ?? ""));
  if (commands.length === 0 || !commands.every((c) => /--codex-rollout-usage/.test(c))) process.exit(1);
' "$TMP/home/.codex/hooks.json" || die "Codex hook not registered with --codex-rollout-usage"

if [ "$REAL_AGENTS" = 1 ]; then
# shellcheck source=lib/real-agents.sh
. "$LIB/real-agents.sh"
else
# --- 1. agent events before launch, from the main checkout ----------------------------
log "agent events before launch (claude-code $CLAUDE_SESSION, codex $CODEX_SESSION)"
event hook claude-code SessionStart "$CLAUDE_SESSION" "$REPO" "transcript=$TRANSCRIPT"
event hook claude-code UserPromptSubmit "$CLAUDE_SESSION" "$REPO" "transcript=$TRANSCRIPT"
event hook codex SessionStart "$CODEX_SESSION" "$REPO" "model=$CODEX_MODEL" "transcript=$CODEX_ROLLOUT"
event hook codex UserPromptSubmit "$CODEX_SESSION" "$REPO" "turn=t0" "transcript=$CODEX_ROLLOUT"
sleep 1

# --- 2. launch from the agent session; a second agent joins; work -------------------
log "har env launch 1 --work-id $WORK_ID (from the claude-code session)"
step "launch" as_claude har env launch 1 --work-id "$WORK_ID" --work-title "Local stack e2e"
SLOT="$(slot_dir)"
[ -d "$SLOT" ] || die "launch left no work dir"
ATTEMPT="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".har/slots/agent-1.json","utf8")).attemptId)')"
log "codex joins the slot (har env work-bind 1 --work-id $WORK_ID)"
step "codex joins" as_codex har env work-bind 1 --work-id "$WORK_ID"
LAUNCHED_AT="$(segment_time claude_code "$CLAUDE_SESSION" from)"
JOINED_AT="$(segment_time codex "$CODEX_SESSION" from)"
[ -n "$LAUNCHED_AT" ] && [ -n "$JOINED_AT" ] || die "no session segment after launch / work-bind"

GREETINGS=("hello, local stack" "hello again, local stack")
claude_turn "$SLOT" 120 340 5000 800 40 90 2000
echo "${GREETINGS[0]}" >"$SLOT/src/greeting.txt"
codex_turn "$SLOT" t1 12000 8000 1500
CODEX_TURNS+=('{"input":12000,"cached":8000,"output":1500}')

# --- 3. full verify, commit ---------------------------------------------------------
verify_and_commit "Change the greeting" as_claude

# --- 4. a changed tree, verified again in the same attempt ----------------------------
claude_turn "$SLOT" 80 210 9000 300 30 70 2500
echo "${GREETINGS[1]}" >"$SLOT/src/greeting.txt"
codex_turn "$SLOT" t2 20000 15000 2500
CODEX_TURNS+=('{"input":20000,"cached":15000,"output":2500}')
verify_and_commit "Change the greeting again" as_claude
flush

# --- 5. complete from a terminal with no agent session --------------------------------
log "har env complete 1 (no agent session in the environment)"
step "complete" sandbox har env complete 1
flush
COMPLETED_AT="$(segment_time claude_code "$CLAUDE_SESSION" to)"
[ -n "$COMPLETED_AT" ] || die "complete left the claude-code segment open"
sleep 1
log "agent events after complete"
event hook claude-code PreToolUse "$CLAUDE_SESSION" "$REPO"
codex_turn "$REPO" t3 26000 19000 3100
flush
sleep 3
fi

# --- state for the checks -------------------------------------------------------------
MC_HEADERS="$("$MC_ADAPTER" read-headers)"
HOSTED_HEADERS=""
[ $HOSTED_ON = 1 ] && HOSTED_HEADERS="$("$HOSTED_ADAPTER" read-headers)"
commits_json() {
  local first=1 sha
  printf '['
  for sha in "$@"; do
    [ $first = 1 ] || printf ','
    first=0
    node -e '
      const [sha, tree, message] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({ sha, tree, message }));
    ' "$sha" "$(cd "$REPO" && sandbox git rev-parse "$sha^{tree}")" "$(cd "$REPO" && sandbox git log -1 --format=%B "$sha")"
  done
  printf ']'
}
write_state() {
  node -e '
    const [file, ...a] = process.argv.slice(1);
    const headers = (text) => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
    const [repoUrl, workId, claude, codex, attemptId, launch, join, complete, collectorDir, commits, greetings, claudeGenerations, codexTurns,
      codexModel, mcAdapter, mcRead, mcHeaders, hostedAdapter, hostedRead, hostedHeaders] = a;
    const rx = (name, adapter, readBase, h) => ({ name, adapter, readBase, headers: headers(h) });
    require("fs").writeFileSync(file, JSON.stringify({
      repoUrl, workId, sessions: { claude_code: claude, codex }, attemptId,
      times: { launch, codexJoin: join, complete }, collectorDir,
      commits: JSON.parse(commits), greetings: JSON.parse(greetings), claudeGenerations: JSON.parse(claudeGenerations),
      codexTurns: JSON.parse(codexTurns), codexModel,
      receivers: [rx("mission-control", mcAdapter, mcRead, mcHeaders), ...(hostedAdapter ? [rx("hosted", hostedAdapter, hostedRead, hostedHeaders)] : [])],
    }, null, 2));
  ' "$TMP/state.json" "$REPO_URL" "$WORK_ID" "$CLAUDE_SESSION" "$CODEX_SESSION" "$ATTEMPT" "$LAUNCHED_AT" "$JOINED_AT" "$COMPLETED_AT" \
    "$TMP/collector" "$(commits_json "${COMMITS[@]}")" "$(printf '%s\n' "${GREETINGS[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')" \
    "[$(IFS=,; echo "${CLAUDE_GENERATIONS[*]}")]" "[$(IFS=,; echo "${CODEX_TURNS[*]}")]" "$CODEX_MODEL" \
    "$MC_ADAPTER" "$MC_READ" "$MC_HEADERS" "$HOSTED_ADAPTER" "$HOSTED_READ" "$HOSTED_HEADERS"
}
write_state || die "cannot write the check state"
if [ "$REAL_AGENTS" = 1 ]; then
  node -e '
    const fs = require("fs");
    const [file, ...reports] = process.argv.slice(1);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state.sessions.codex) delete state.sessions.codex;
    state.realAgents = { claudeReports: reports.map((r) => JSON.parse(fs.readFileSync(r, "utf8"))) };
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  ' "$TMP/state.json" "$TMP/claude-1.json" "$TMP/claude-2.json" || die "cannot write the check state"
fi

# --- checks 1 to 7, 10, 11, 13 ----------------------------------------------------------
log "checks"
check trailers
for rx in "${RECEIVERS[@]}"; do check view "$rx"; done
for rx in "${RECEIVERS[@]}"; do check evidence "$rx"; done
for rx in "${RECEIVERS[@]}"; do check proof "$rx"; done
for target in "${RECEIVERS[@]}" collector; do check stamping "$target"; done
for target in "${RECEIVERS[@]}" collector; do check vtrace "$target"; done
for target in "${RECEIVERS[@]}" collector; do check usage "$target"; done
[ $HOSTED_ON = 1 ] && check usage-agree
check collector
for rx in "${RECEIVERS[@]}"; do check trajectory "$rx"; done
for rx in "${RECEIVERS[@]}"; do check metrics "$rx"; done
[ "$REAL_AGENTS" = 1 ] && check agent-report

levels=()
notes_ok=1
for sha in "${COMMITS[@]}"; do
  out="$(cd "$REPO" && sandbox git factory verify "$sha" --min-level L1 2>&1)" && levels+=("$out") || { notes_ok=0; levels+=("$out"); }
done
if [ $notes_ok = 1 ]; then
  report PASS "11 git-notes" "git factory verify --min-level L1: $(IFS=';'; echo "${levels[*]}")"
else
  report FAIL "11 git-notes" "$(IFS=';'; echo "${levels[*]}")"
fi

if [ "$REAL_AGENTS" = 1 ]; then
  for skipped in "8 mission-control-down" "9 hosted-down" "12 v1-compat"; do echo "SKIP $skipped: not run with --real-agents"; done
  log "done: $FAILS failing check(s)"
  [ "$FAILS" -eq 0 ]
  exit
fi

# --- 8. Mission Control down -----------------------------------------------------------
log "8: Mission Control down — launch $WORK_ID_B, verify and commit"
step "launch B" as_claude har env launch 1 --work-id "$WORK_ID_B" --work-title "Local stack e2e, outages"
SLOT="$(slot_dir)"
MC_STOPPED=1
"$MC_ADAPTER" stop >>"$LOG" 2>&1 || die "Mission Control did not stop"
echo "hello while Mission Control is down" >"$SLOT/src/greeting.txt"
COMMITS_B=()
COMMITS=()
verify_and_commit "Change the greeting with Mission Control down" as_claude
COMMITS_B+=("${COMMITS[@]}")
flush
problems=()
hosted_detail="no hosted receiver"
if [ $HOSTED_ON = 1 ]; then
  hosted_detail="$("${CHECKS[@]}" probe-received "$TMP/state.json" hosted "$WORK_ID_B" "${COMMITS_B[@]}" 2>>"$LOG")" || problems+=("$hosted_detail")
fi
mc_queued="$(queue_pending mission-control)"
[ "$mc_queued" -gt 0 ] || problems+=("nothing queued for Mission Control while it was down")
"$MC_ADAPTER" start >>"$LOG" 2>&1 || problems+=("Mission Control did not come back")
unset MC_STOPPED
flush
mc_detail="$("${CHECKS[@]}" probe-received "$TMP/state.json" mission-control "$WORK_ID_B" "${COMMITS_B[@]}" 2>>"$LOG")" || problems+=("$mc_detail")
[ "$(queue_pending mission-control)" -eq 0 ] || problems+=("Mission Control queue still holds $(queue_pending mission-control) entries")
if [ ${#problems[@]} -eq 0 ]; then
  report PASS "8 mission-control-down" "verify+commit with Mission Control down; $hosted_detail; $mc_queued entries queued for Mission Control, drained after restart; $mc_detail"
else
  report FAIL "8 mission-control-down" "$(IFS=';'; echo "${problems[*]}")"
fi

# --- 9. hosted receiver down -------------------------------------------------------------
if [ $HOSTED_ON = 1 ]; then
log "9: hosted receiver down — codex joins, works, verify and commit"
HOSTED_STOPPED=1
"$HOSTED_ADAPTER" stop >>"$LOG" 2>&1 || die "hosted receiver did not stop"
step "codex joins B" as_codex har env work-bind 1 --work-id "$WORK_ID_B"
codex_turn "$SLOT" t4 30000 20000 4000
echo "hello while the hosted receiver is down" >"$SLOT/src/greeting.txt"
started=$(date +%s)
COMMITS=()
verify_and_commit "Change the greeting with the hosted receiver down" as_claude
took=$(($(date +%s) - started))
COMMITS_B+=("${COMMITS[@]}")
flush
problems=()
hosted_queued="$(queue_pending hq)"
[ "$hosted_queued" -gt 0 ] || problems+=("nothing queued for the hosted receiver while it was down")
"$HOSTED_ADAPTER" start >>"$LOG" 2>&1 || problems+=("hosted receiver did not come back")
unset HOSTED_STOPPED
flush
# otel-hook sends what it queued on its first hook event after its down window
# for the receiver (30 s after the last failed export) has passed: until then
# every hook spools without trying.
wait_otel_hook_down_windows
event hook codex UserPromptSubmit "$CODEX_SESSION" "$SLOT" "turn=t5" "transcript=$CODEX_ROLLOUT"
flush
hosted_detail="$("${CHECKS[@]}" probe-received "$TMP/state.json" hosted "$WORK_ID_B" "${COMMITS_B[@]}" 2>>"$LOG")" || problems+=("$hosted_detail")
usage_detail="$("${CHECKS[@]}" probe-usage "$TMP/state.json" hosted "$WORK_ID_B" "$CODEX_MODEL" 1 2>>"$LOG")" || problems+=("$usage_detail")
[ "$(queue_pending hq)" -eq 0 ] || problems+=("hosted queue still holds $(queue_pending hq) entries")
if [ ${#problems[@]} -eq 0 ]; then
  report PASS "9 hosted-down" "verify+commit took ${took}s with the hosted receiver down; $hosted_queued entries queued, drained after restart; $hosted_detail; $usage_detail"
else
  report FAIL "9 hosted-down" "$(IFS=';'; echo "${problems[*]}")"
fi
else
  echo "SKIP 9 hosted-down: no hosted receiver (HAR_E2E_HOSTED_ADAPTER unset)"
fi
step "complete B" sandbox har env complete 1
flush

# --- 12. HAR 1.x against the hosted receiver's v1 sync ---------------------------------------
if [ $HOSTED_ON = 0 ]; then
  echo "SKIP 12 v1-compat: no hosted receiver (HAR_E2E_HOSTED_ADAPTER unset)"
  log "done: $FAILS failing check(s)"
  [ "$FAILS" -eq 0 ]
  exit
fi
log "12: HAR 1.x sync to the hosted receiver's v1 endpoint"
if [ -z "$HAR1_CLI" ]; then
  step "install HAR 1.x" npm install --prefix "$TMP/v1/prefix" --no-audit --no-fund --ignore-scripts @osfactory/har@latest
  HAR1_CLI="$TMP/v1/prefix/node_modules/@osfactory/har/dist/index.js"
fi
"$HOSTED_ADAPTER" v1-headers >"$TMP/v1/headers" 2>>"$LOG" || : >"$TMP/v1/headers"
node "$LIB/recording-proxy.mjs" "$TMP/v1/port" "$TMP/v1/exchanges.jsonl" "$HOSTED_INGEST" "$TMP/v1/headers" >>"$LOG" 2>&1 &
PIDS+=($!)
# A Mission Control 1.x is not part of this stack: a stand-in answers 404 (an older
# Mission Control), so 1.x syncs to the hosted receiver alone.
node -e '
  const s = require("http").createServer((q, r) => { r.writeHead(404, { "content-type": "application/json" }); r.end("{}"); });
  s.listen(0, "127.0.0.1", () => require("fs").writeFileSync(process.argv[1], String(s.address().port)));
' "$TMP/v1/mc-port" >>"$LOG" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do [ -s "$TMP/v1/port" ] && [ -s "$TMP/v1/mc-port" ] && break; sleep 0.1; done
v1() {
  env -i PATH="$TMP/v1/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" HOME="$TMP/v1/home" TMPDIR="$TMP" TERM=dumb \
    HAR_CONTROL_API_URL="http://127.0.0.1:$(cat "$TMP/v1/mc-port")" \
    HAR_PORTAL_URL="http://127.0.0.1:$(cat "$TMP/v1/port")" HAR_API_URL="http://127.0.0.1:$(cat "$TMP/v1/port")" \
    HAR_PORTAL_TOKEN="$HOSTED_KEY" HAR_TELEMETRY=off \
    GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test \
    "$@"
}
V1_REPO="$TMP/v1/repo"
mkdir -p "$V1_REPO" && cp -R "$FIXTURE/project/." "$V1_REPO/"
(
  cd "$V1_REPO" &&
    v1 git init -q -b main && v1 git remote add origin "https://example.test/har-local-stack/$RUN_TAG-v1.git" &&
    v1 git add -A && v1 git commit -qm fixture &&
    v1 node "$HAR1_CLI" env init --profile cli --yes --no-agents --no-cursor-rule --commit-gate never &&
    v1 node "$HAR1_CLI" control register --repo . --portal
  v1 node "$HAR1_CLI" control sync
) >"$TMP/v1/output.txt" 2>&1
cat "$TMP/v1/output.txt" >>"$LOG"
V1_VERSION="$(node "$HAR1_CLI" --version 2>/dev/null)"
v1_detail="$(node -e '
  const fs = require("fs");
  const lines = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
  const syncs = lines.filter((l) => l.path.startsWith("/sync"));
  const ok = syncs.filter((l) => l.status >= 200 && l.status < 300);
  const headed = ok.filter((l) => l.deprecation && l.sunset && /rel="?deprecation/.test(l.link ?? ""));
  const output = fs.readFileSync(process.argv[2], "utf8");
  const landed = /HQ sync completed|✓|Synced/.test(output) && !/HQ: /.test(output);
  const pass = ok.length > 0 && headed.length === ok.length && landed;
  console.log(`${pass ? "PASS" : "FAIL"}\t${syncs.length} POST /sync (${ok.map((l) => l.status).join(",") || syncs.map((l) => l.status).join(",") || "none"}), ${headed.length} with Deprecation ${ok[0]?.deprecation ?? "-"}, Sunset ${ok[0]?.sunset ?? "-"}, Link ${ok[0]?.link ?? "-"}; HQ leg ${landed ? "completed" : "failed"}`);
' "$TMP/v1/exchanges.jsonl" "$TMP/v1/output.txt")"
report "${v1_detail%%$'\t'*}" "12 v1-compat" "HAR $V1_VERSION: ${v1_detail#*$'\t'}"

log "done: $FAILS failing check(s)"
[ "$FAILS" -eq 0 ]

# Real agent sessions for run.sh --real-agents (sourced by run.sh; uses its
# sandbox, step, flush, segment_time, slot_dir and verify_and_commit).
#
# Instead of replaying hook payloads, a real Claude Code session (`claude -p`)
# and, when Codex is installed and logged in, a real Codex session (`codex exec`)
# call real models inside the sandbox, with the hooks HAR registered there:
#   - Claude Code, from the main checkout: runs `har env launch` itself, writes
#     the greeting in the slot, and has an Explore subagent read it back;
#   - Codex, in the slot: joins with `har env work-bind` and reads the file;
#   - the script runs `har env verify --full`, commits and completes as the
#     Claude Code session would (same session id in the environment);
#   - the Claude Code session is resumed once after complete (outside the attempt).
#
# Login: only the credential files are copied into the sandbox HOME (mode 600)
# and deleted as soon as the sessions are done (and on exit).
# Spend: a small model each (HAR_E2E_REAL_CLAUDE_MODEL, default haiku;
# HAR_E2E_REAL_CODEX_MODEL, default gpt-5.6-luna) and a budget cap for Claude Code.

REAL_CLAUDE_BIN="${HAR_E2E_CLAUDE_BIN:-$(command -v claude || true)}"
REAL_CODEX_BIN="${HAR_E2E_CODEX_BIN:-$(command -v codex || true)}"
REAL_CLAUDE_MODEL="${HAR_E2E_REAL_CLAUDE_MODEL:-haiku}"
REAL_CODEX_MODEL="${HAR_E2E_REAL_CODEX_MODEL:-gpt-5.6-luna}"
REAL_CLAUDE_BUDGET="${HAR_E2E_REAL_CLAUDE_BUDGET_USD:-0.40}"
CLAUDE_CREDENTIALS="${HAR_E2E_CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
CODEX_AUTH="${HAR_E2E_CODEX_AUTH:-$HOME/.codex/auth.json}"

[ -n "$REAL_CLAUDE_BIN" ] || die "--real-agents: no claude CLI (HAR_E2E_CLAUDE_BIN)"
REAL_CLAUDE_BIN="$(readlink -f "$REAL_CLAUDE_BIN")"
[ -f "$CLAUDE_CREDENTIALS" ] || die "--real-agents: no Claude Code login at $CLAUDE_CREDENTIALS"
REAL_CODEX=0
if [ -n "$REAL_CODEX_BIN" ] && [ -f "$CODEX_AUTH" ]; then
  REAL_CODEX=1
  REAL_CODEX_BIN="$(readlink -f "$REAL_CODEX_BIN")"
fi

# --- credentials: copied, never printed, deleted after the sessions -------------------
install_credential() { # <source> <destination>
  mkdir -p "$(dirname "$2")"
  (umask 077 && cp "$1" "$2") || die "--real-agents: cannot copy a credential file into the sandbox"
  chmod 600 "$2"
  CREDENTIAL_FILES+=("$2")
}
remove_credentials() {
  local file
  for file in "${CREDENTIAL_FILES[@]}"; do rm -f "$file"; done
}
install_credential "$CLAUDE_CREDENTIALS" "$TMP/home/.claude/.credentials.json"
[ $REAL_CODEX = 1 ] && install_credential "$CODEX_AUTH" "$TMP/home/.codex/auth.json"

# The agents print the slot's work dir with this, after they launched it.
printf '#!/usr/bin/env bash\nexec node -e %q %q\n' \
  'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workDir + "\n")' \
  "$REPO/.har/slots/agent-1.json" >"$TMP/bin/e2e-slot-dir"
chmod +x "$TMP/bin/e2e-slot-dir"
mkdir -p "$TMP/home/worktrees"

# Claude Code: no native telemetry, no updater, no nonessential traffic; only the
# tools the task needs; the worktrees of the sandbox HOME are a working directory.
real_claude() { # <report.json> <prompt> [claude args...]
  local out=$1 prompt=$2
  shift 2
  echo "### claude -p ($out)" >>"$LOG"
  sandbox DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    "$REAL_CLAUDE_BIN" -p "$prompt" --output-format json --model "$REAL_CLAUDE_MODEL" \
    --max-budget-usd "$REAL_CLAUDE_BUDGET" --permission-mode acceptEdits --add-dir "$TMP/home/worktrees" \
    --allowedTools 'Bash(har env launch:*)' 'Bash(e2e-slot-dir)' Write Read Agent Glob Grep \
    "$@" >"$out" 2>>"$LOG"
  local code=$?
  cat "$out" >>"$LOG"
  [ $code = 0 ] && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(r.is_error ? 1 : 0)' "$out" ||
    die "claude -p failed (see $out)"
}

GREETINGS=("hello, local stack")
log "real Claude Code session $CLAUDE_SESSION ($REAL_CLAUDE_MODEL): launch, edit, Explore subagent"
real_claude "$TMP/claude-1.json" "You are exercising a test harness in a scratch repository. Do exactly these steps, in order, nothing else:
1. Run this Bash command: har env launch 1 --work-id $WORK_ID --work-title 'Local stack e2e'
2. Run this Bash command: e2e-slot-dir
   It prints one absolute directory path; call it W.
3. Use the Write tool to overwrite the file W/src/greeting.txt with exactly this content (one line): ${GREETINGS[0]}
4. Use the Agent tool with subagent_type Explore and ask it to read W/src/greeting.txt with the Read tool and report the file's content (use the real path for W).
5. Reply with the single word DONE." --session-id "$CLAUDE_SESSION"
[ -f .har/slots/agent-1.json ] || die "the Claude Code session did not launch the slot"
SLOT="$(slot_dir)"
[ -d "$SLOT" ] || die "launch left no work dir"
ATTEMPT="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".har/slots/agent-1.json","utf8")).attemptId ?? "")')"
LAUNCHED_AT="$(segment_time claude_code "$CLAUDE_SESSION" from)"
[ -n "$ATTEMPT" ] && [ -n "$LAUNCHED_AT" ] || die "the launch from the Claude Code session opened no attempt / session segment"
GREETINGS[0]="$(cat "$SLOT/src/greeting.txt")"

JOINED_AT=""
CODEX_TURNS=()
if [ $REAL_CODEX = 1 ]; then
  log "real Codex session ($REAL_CODEX_MODEL) in the slot: har env work-bind, read the file"
  echo "### codex exec" >>"$LOG"
  (cd "$SLOT" && sandbox CODEX_HOME="$TMP/home/.codex" "$REAL_CODEX_BIN" exec --json --model "$REAL_CODEX_MODEL" \
    -c model_reasoning_effort='"low"' --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
    --skip-git-repo-check "Run these two shell commands, one at a time, then reply DONE and stop: \`har env work-bind 1 --work-id $WORK_ID\`, then \`cat src/greeting.txt\`.") \
    >"$TMP/codex-1.jsonl" 2>>"$LOG" || die "codex exec failed (see $TMP/codex-1.jsonl)"
  cat "$TMP/codex-1.jsonl" >>"$LOG"
  CODEX_SESSION="$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.startsWith("{")).map(JSON.parse);
    process.stdout.write(lines.find((l) => l.type === "thread.started")?.thread_id ?? "");
  ' "$TMP/codex-1.jsonl")"
  [ -n "$CODEX_SESSION" ] || die "codex exec printed no thread id"
  # Codex reports each turn's usage; receivers book what otel-hook reports (running totals).
  mapfile -t CODEX_TURNS < <(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.startsWith("{")).map(JSON.parse);
    let total = { input: 0, cached: 0, output: 0 };
    for (const l of lines.filter((x) => x.type === "turn.completed")) {
      total = { input: total.input + l.usage.input_tokens, cached: total.cached + (l.usage.cached_input_tokens ?? 0), output: total.output + l.usage.output_tokens };
      console.log(JSON.stringify(total));
    }
  ' "$TMP/codex-1.jsonl")
  JOINED_AT="$(segment_time codex "$CODEX_SESSION" from)"
  [ -n "$JOINED_AT" ] || die "the Codex session's har env work-bind opened no session segment (CODEX_THREAD_ID not set for its commands?)"
fi

# --- verify, commit and complete, as the Claude Code session -------------------------
verify_and_commit "Change the greeting" as_claude
flush
log "har env complete 1 (no agent session in the environment)"
step "complete" sandbox har env complete 1
flush
COMPLETED_AT="$(segment_time claude_code "$CLAUDE_SESSION" to)"
[ -n "$COMPLETED_AT" ] || die "complete left the claude-code segment open"
sleep 1

log "the Claude Code session again, after complete (outside the attempt)"
real_claude "$TMP/claude-2.json" "Use the Read tool to read src/greeting.txt, then reply with its content only." --resume "$CLAUDE_SESSION"
remove_credentials
log "credential copies deleted"
flush
sleep 3

# --- what the agents reported themselves, and the generations otel-hook exported -------
# Expected Claude Code usage = the generations the Collector holds for the session
# inside the attempt (each booked once by the receivers); the agents' own reports
# are compared in check 14.
mapfile -t CLAUDE_GENERATIONS < <(node -e '
  const fs = require("fs"), path = require("path");
  const [dir, session, attempt] = process.argv.slice(1);
  const value = (v) => v && ("stringValue" in v ? v.stringValue : "intValue" in v ? Number(v.intValue) : "doubleValue" in v ? v.doubleValue : undefined);
  const attrs = (list) => Object.fromEntries((list ?? []).map((e) => [e.key, value(e.value)]));
  const file = path.join(dir, "traces.jsonl");
  const seen = new Set();
  for (const line of (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").split("\n").filter(Boolean)) {
    for (const rs of JSON.parse(line).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) {
      const a = { ...attrs(rs.resource?.attributes), ...attrs(span.attributes) };
      if (!/^generation( |$)/.test(span.name) || a["otelhook.session.id"] !== session || a["factory.attempt.id"] !== attempt) continue;
      if (seen.has(a["otelhook.generation.id"])) continue;
      seen.add(a["otelhook.generation.id"]);
      const cacheRead = a["gen_ai.usage.cache_read.input_tokens"] ?? 0, cacheCreation = a["gen_ai.usage.cache_creation.input_tokens"] ?? 0;
      console.log(JSON.stringify({ model: a["gen_ai.response.model"] ?? a["gen_ai.request.model"], input: a["gen_ai.usage.input_tokens"] - cacheRead - cacheCreation,
        output: a["gen_ai.usage.output_tokens"] ?? 0, cacheRead, cacheCreation, ...(a["otelhook.subagent.id"] ? { subagent: a["otelhook.subagent.id"] } : {}) }));
    }
  }
' "$TMP/collector" "$CLAUDE_SESSION" "$ATTEMPT")
[ ${#CLAUDE_GENERATIONS[@]} -gt 0 ] || die "the Collector holds no Claude Code generation inside the attempt"
CODEX_MODEL="$REAL_CODEX_MODEL"
COMMITS_REAL=("${COMMITS[@]}")

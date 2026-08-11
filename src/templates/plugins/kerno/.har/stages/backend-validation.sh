#!/usr/bin/env bash
# Kerno deterministic backend/API scenario validation for an agent slot.
# Re-runs the committed Kerno suite (.kerno/scenarios/) against the running slot
# via the local Kerno agent's REST API. Outputs JSON to stdout, progress to stderr.
#
# Usage: ./.har/stages/backend-validation.sh <agent-id>
# Prerequisite: ./.har/launch.sh <agent-id>, the app running in the slot, AND a Kerno
#   agent started with `kerno init` in THIS worktree (Kerno allows ONE agent per machine).
# See: ./.har/stages/KERNO.md for the full setup + adaptation guide.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
# agent-slot.sh expects SCRIPT_DIR to be .har/ (slot registry lives there)
SCRIPT_DIR="$HARNESS_DIR"

# shellcheck source=/dev/null
source "$HARNESS_DIR/harness.env"
# shellcheck source=/dev/null
source "$HARNESS_DIR/agent-slot.sh"

AGENT_ID="${1:?Usage: backend-validation.sh <agent-id>}"
validate_agent_id "$AGENT_ID"

log() { echo "==> [backend-validation agent-$AGENT_ID] $*" >&2; }

ARTIFACT_DIR="$REPO_ROOT/.har/artifacts/backend-validation"
TOTAL_MS=0

# Emit a result JSON envelope to stdout (used for both early failures and the final result).
emit_result() {
  local status="$1"; local message="${2:-}"
  STATUS="$status" MSG="$message" AID="$AGENT_ID" TMS="$TOTAL_MS" SUT="${API_URL:-}" node -e "
const out = {
  status: process.env.STATUS,
  stageId: 'backend-validation',
  kind: 'test',
  agent_id: Number(process.env.AID),
  total_ms: Number(process.env.TMS || 0),
  artifacts: [{ path: '.har/artifacts/backend-validation', kind: 'directory' }],
};
if (process.env.MSG) out.message = process.env.MSG;
if (process.env.SUT) out.urls = [{ label: 'sut', url: process.env.SUT }];
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"
}

# ── Rule 2: machine-level lock (Kerno allows one agent at a time) ──────────────
# Stock macOS bash 3.2 has no `flock` binary, so use an atomic mkdir lock with a
# stale-PID check. Fail fast (never block) so a second slot can't stomp a live run.
LOCK_DIR="$HOME/.kerno/har-backend-validation.lock"
MARKER=""
cleanup() {
  [ -n "${LOCK_DIR:-}" ] && rm -rf "$LOCK_DIR" 2>/dev/null || true
  [ -n "${MARKER:-}" ] && rm -f "$MARKER" 2>/dev/null || true
}

fail() {
  log "✗ $*"
  emit_result fail "$*"
  exit 1
}

acquire_lock() {
  mkdir -p "$HOME/.kerno" 2>/dev/null || true
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" > "$LOCK_DIR/pid"; return 0; fi
  local other=""
  [ -f "$LOCK_DIR/pid" ] && other="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then return 1; fi
  # stale lock — reclaim once
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" > "$LOCK_DIR/pid"; return 0; fi
  return 1
}

if ! acquire_lock; then
  # Do NOT trap-remove a lock we don't own.
  fail "another Kerno validation is already in progress on this machine (lock: $LOCK_DIR). Kerno allows one agent at a time — retry after it finishes."
fi
trap cleanup EXIT

# ── Resolve agent env + slot target ───────────────────────────────────────────
ENV_FILE="$(resolve_agent_env_file "$AGENT_ID" "$REPO_ROOT")" || {
  echo "No .env.agent.${AGENT_ID} found." >&2
  har_suggest_launch "$AGENT_ID" >&2
  exit 1
}

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

WORK_DIR="$(resolve_agent_work_dir "$ENV_FILE")"

# SUT URL: prefer an explicit override, then the app's own SITE_URL (both the default
# web profile and single-port apps like Next.js set SITE_URL to the running app), then a
# port fallback (PORT for single-port apps, else API_PORT).
APP_PORT="${PORT:-${API_PORT:-${FE_PORT:-}}}"
API_URL="${SUT_URL:-${SITE_URL:-}}"
if [ -z "$API_URL" ] && [ -n "$APP_PORT" ]; then
  API_URL="http://localhost:${APP_PORT}"
fi
[ -n "$API_URL" ] || fail "Could not determine the slot SUT URL. Set SUT_URL, or ensure the slot env defines SITE_URL or PORT/API_PORT."

# Slot database (greybox). The launch env file already exports DATABASE_URL for the
# per-slot DB (agent_<id>); reconstruct it from DB_PORT only if absent. Omitted for
# black-box (HTTP-only) apps that expose no slot DB.
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -n "${DB_PORT:-}" ]; then
  DB_URL="postgresql://postgres:password@localhost:${DB_PORT}/agent_${AGENT_ID}"
fi

# ── Discover the Kerno agent (never spawn it — spawning kills other agents) ────
KERNO_PORT="${KERNO_AGENT_PORT:-}"
if [ -z "$KERNO_PORT" ] && [ -f "$HOME/.kerno/agent.port" ]; then
  KERNO_PORT="$(cat "$HOME/.kerno/agent.port" 2>/dev/null || true)"
fi
KERNO_PORT="${KERNO_PORT:-8085}"
AGENT_URL="http://127.0.0.1:${KERNO_PORT}"

# ── Rule 1: preflight — assume-and-verify, never spawn/rebind ──────────────────
# The stage drives Kerno entirely over REST and never invokes the `kerno` CLI, so
# reachability of the agent (not the CLI being on PATH) is the real requirement.
command -v curl  >/dev/null 2>&1 || fail "curl is required but was not found on PATH."
docker info >/dev/null 2>&1 || fail "Docker is not running. Kerno executes scenarios in a container — start Docker and retry."
curl -sf "$AGENT_URL/health" >/dev/null 2>&1 || fail "No Kerno agent reachable at $AGENT_URL. Install the Kerno CLI (npm install -g @kerno/cli) and run 'kerno init' in this worktree first (Kerno allows one agent per machine). Override the port with KERNO_AGENT_PORT."

WORKSPACES_JSON="$(curl -sf "$AGENT_URL/workspaces" 2>/dev/null || true)"
[ -n "$WORKSPACES_JSON" ] || fail "Could not read Kerno workspaces from $AGENT_URL/workspaces."

# Extract workspaceId, applicationId, and the bound workspace path from the first
# (only) workspace. Field-by-field extraction avoids delimiter-splitting pitfalls when
# a field (e.g. an absent applicationId) is empty.
ws_field() { printf '%s' "$WORKSPACES_JSON" | node -e "$1" 2>/dev/null || true; }
WID="$(ws_field 'const w=JSON.parse(require("fs").readFileSync(0,"utf8"))[0]||{};process.stdout.write(w.id||"")')"
AID="$(ws_field 'const w=JSON.parse(require("fs").readFileSync(0,"utf8"))[0]||{};const a=(w.applications||[])[0];process.stdout.write(a&&a.id?a.id:"")')"
WS_PATH="$(ws_field 'const w=JSON.parse(require("fs").readFileSync(0,"utf8"))[0]||{};process.stdout.write(w.path||"")')"
PATH_MATCH="$(WSP="$WS_PATH" WD="$WORK_DIR" node -e 'const fs=require("fs");const r=p=>{try{return fs.realpathSync(p)}catch(e){return p||""}};const wsp=process.env.WSP||"";process.stdout.write(wsp&&r(wsp)===r(process.env.WD||"")?"1":"0")' 2>/dev/null || echo 0)"

[ -n "${WID:-}" ] || fail "Kerno agent has no analyzed workspace yet. Run 'kerno init' in this worktree."
if [ "${PATH_MATCH:-0}" != "1" ]; then
  fail "Kerno agent is bound to '${WS_PATH:-unknown}', not this slot worktree ('$WORK_DIR'). Run 'kerno init' in this worktree first (Kerno allows one agent per machine)."
fi

# Resolve the applicationId. Precedence: explicit KERNO_APP_ID override, then the
# workspace's HTTP/MCP-serving application (the normal case). If Kerno analyzed a
# module but did not classify it as HTTP-serving, /workspaces omits it — fall back to
# the module list Kerno leaks in a 404 body so validation still works, with a note.
if [ -n "${KERNO_APP_ID:-}" ]; then
  AID="$KERNO_APP_ID"
elif [ -z "$AID" ]; then
  PROBE="$(curl -s "$AGENT_URL/workspaces/$WID/applications/__har_kerno_probe__/config" 2>/dev/null || true)"
  AID="$(printf '%s' "$PROBE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const m=d.match(/has modules: \[([^\]]*)\]/);process.stdout.write(m&&m[1].trim()?m[1].split(",")[0].trim():"")})' 2>/dev/null || true)"
  [ -n "$AID" ] && log "note: no HTTP-classified application in /workspaces; falling back to analyzed module '$AID' (Kerno may not have classified this app as HTTP-serving). Set KERNO_APP_ID to pin it."
fi
[ -n "${AID:-}" ] || fail "Kerno detected no usable application in this workspace. Set KERNO_APP_ID (see 'kerno_get_applications' → unsupported_apps for the id) or confirm the app was analyzed and a suite generated."

# Suite must already exist — validate never generates.
SCEN_DIR="$WORK_DIR/.kerno/scenarios/endpoints"
SCEN_FILES="$(find "$SCEN_DIR" -name '*.scenario.ts' 2>/dev/null | sort)"
[ -n "$SCEN_FILES" ] || fail "No Kerno scenario suite under .kerno/scenarios/endpoints/. Ask your Kerno agent to generate scenarios first — validate only re-runs an existing suite."

# ── Point Kerno's config at this slot (REST PATCH — same writer as save_config) ──
# The env map is injected verbatim into the sandbox. It carries the slot DB plus any
# KERNO_SANDBOX_ENV the app's scenarios need at runtime (test-user email, tokens, flags),
# as newline- or semicolon-separated KEY=VALUE pairs. Kerno treats the block name as
# organisational only, so all values are injected regardless of the block.
CONFIG_BODY="$(API_URL="$API_URL" DB_URL="$DB_URL" EXTRA="${KERNO_SANDBOX_ENV:-}" node -e '
const body = { sut: { inputUrl: process.env.API_URL }, targetEnvironment: "local" };
const env = {};
if (process.env.DB_URL) env.DATABASE_URL = process.env.DB_URL;
(process.env.EXTRA || "").split(/[;\n]+/).forEach((p) => {
  const i = p.indexOf("=");
  if (i < 1) return;
  const k = p.slice(0, i).trim();
  const v = p.slice(i + 1).trim();
  if (/^[A-Z_][A-Z0-9_]*$/.test(k)) env[k] = v;
});
if (Object.keys(env).length) body.postgres = env;
process.stdout.write(JSON.stringify(body));
')"
curl -sf -X PATCH "$AGENT_URL/workspaces/$WID/applications/$AID/config" \
  -H 'content-type: application/json' -d "$CONFIG_BODY" >/dev/null 2>&1 \
  || fail "Failed to set Kerno target config (PATCH /workspaces/$WID/applications/$AID/config)."

log "Validating against SUT $API_URL${DB_URL:+ (greybox DB configured)}"
log "Workspace: $WID  Application: $AID"

# ── Enumerate unique endpoints (METHOD + path) from the on-disk suite ──────────
# Each *.scenario.ts lives in .kerno/scenarios/endpoints/<METHOD>/<path>/ ; the
# endpoint is that parent dir. No `mapfile` — stock macOS bash is 3.2.
ENDPOINTS=""
while IFS= read -r scen; do
  [ -n "$scen" ] || continue
  d="$(dirname "$scen")"
  rel="${d#"$SCEN_DIR"/}"          # e.g. GET/api/health
  method="${rel%%/*}"              # GET
  rest="${rel#*/}"                 # api/health  (== rel when no sub-path)
  if [ "$rest" = "$rel" ]; then rest=""; fi
  path="/${rest}"; path="${path%/}"; [ -z "$path" ] && path="/"
  ENDPOINTS="${ENDPOINTS}${method}	${path}
"
done <<< "$SCEN_FILES"
ENDPOINTS="$(printf '%s' "$ENDPOINTS" | sort -u | sed '/^[[:space:]]*$/d')"

# ── Run each endpoint (synchronous REST; the response is the source of truth) ──
mkdir -p "$ARTIFACT_DIR"
MARKER="$(mktemp)"                 # reference for "fresh" report.json (macOS find has -newer, not -newermt)
START_TOTAL=$(now_ms)
OVERALL_PASS=true
ENDPOINT_RESULTS="[]"

while IFS=$'\t' read -r method path; do
  [ -n "$method" ] || continue
  printf "  → %-6s %-40s" "$method" "$path" >&2

  REQ_BODY="$(METHOD="$method" EPATH="$path" node -e 'process.stdout.write(JSON.stringify({method:process.env.METHOD,path:process.env.EPATH}))')"

  set +e
  RESP="$(curl -s -X POST "$AGENT_URL/workspaces/$WID/applications/$AID/scenarios/run" \
    -H 'content-type: application/json' -d "$REQ_BODY" 2>/dev/null)"
  CURL_EXIT=$?
  set -e

  if [ "$CURL_EXIT" != "0" ]; then
    # Connection reset mid-run usually means the Kerno agent was killed (another
    # agent booted). Surface it as a failure rather than a silent pass.
    echo "✗ (agent unreachable)" >&2
    SUMMARY="$(METHOD="$method" EPATH="$path" node -e 'process.stdout.write(JSON.stringify({method:process.env.METHOD,path:process.env.EPATH,ok:false,total:0,passed:0,error:"agent unreachable mid-run (curl exit '"$CURL_EXIT"')"}))')"
    OVERALL_PASS=false
  else
    SAFE="$(printf '%s' "${method}_${path}" | tr '/ ' '__' | tr -cd 'A-Za-z0-9_.-')"
    printf '%s\n' "$RESP" > "$ARTIFACT_DIR/${SAFE}.run.json"

    SUMMARY="$(printf '%s' "$RESP" | METHOD="$method" EPATH="$path" node -e '
const fs = require("fs");
let raw = ""; try { raw = fs.readFileSync(0, "utf8"); } catch (e) {}
let data; try { data = JSON.parse(raw); } catch (e) {
  process.stdout.write(JSON.stringify({ method: process.env.METHOD, path: process.env.EPATH, ok: false, total: 0, passed: 0, error: "unparseable run response" }));
  process.exit(0);
}
const results = Array.isArray(data.results) ? data.results : [];
const passed = results.filter(r => r.verdict === "passed").length;
const failing = results.filter(r => r.verdict !== "passed");
const bugs = results.filter(r => r.potentialBug).map(r => ({ title: r.potentialBug.title, severity: r.potentialBug.severity || null, scenario: r.scenarioId }));
const ok = results.length > 0 && failing.length === 0;
process.stdout.write(JSON.stringify({
  method: process.env.METHOD, path: process.env.EPATH, ok,
  total: results.length, passed,
  failing: failing.map(r => ({ scenario: r.scenarioId, verdict: r.verdict, status: r.responseStatus })),
  bugs,
}));
')"

    EP_OK="$(printf '%s' "$SUMMARY" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.ok?"1":"0")' 2>/dev/null || echo 0)"
    EP_PASS="$(printf '%s' "$SUMMARY" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(d.passed)+"/"+String(d.total))' 2>/dev/null || echo "?")"
    if [ "$EP_OK" = "1" ]; then
      echo "✓ ($EP_PASS)" >&2
    else
      echo "✗ ($EP_PASS)" >&2
      OVERALL_PASS=false
    fi
  fi

  ENDPOINT_RESULTS="$(printf '%s' "$ENDPOINT_RESULTS" | SUMMARY="$SUMMARY" node -e 'const fs=require("fs");let a=JSON.parse(fs.readFileSync(0,"utf8"));a.push(JSON.parse(process.env.SUMMARY));process.stdout.write(JSON.stringify(a))')"
done <<< "$ENDPOINTS"

END_TOTAL=$(now_ms)
TOTAL_MS=$(( END_TOTAL - START_TOTAL ))

# ── Copy Kerno's own report.json files, but only ones written by THIS run ──────
if [ -d "$WORK_DIR/.kerno" ]; then
  while IFS= read -r rep; do
    [ -n "$rep" ] || continue
    rel="${rep#"$WORK_DIR"/}"
    safe="$(printf '%s' "$rel" | tr '/ ' '__')"
    cp "$rep" "$ARTIFACT_DIR/$safe" 2>/dev/null || true
  done < <(find "$WORK_DIR/.kerno" -name 'report.json' -newer "$MARKER" 2>/dev/null || true)
fi

# ── Emit aggregated result ─────────────────────────────────────────────────────
RESULTS="$ENDPOINT_RESULTS" AID="$AGENT_ID" TMS="$TOTAL_MS" SUT="$API_URL" node -e "
const results = JSON.parse(process.env.RESULTS || '[]');
const overall = results.length > 0 && results.every(r => r.ok);
const scenarios = {
  total: results.reduce((a, r) => a + (r.total || 0), 0),
  passed: results.reduce((a, r) => a + (r.passed || 0), 0),
};
const bugs = results.reduce((a, r) => a.concat(r.bugs || []), []);
const out = {
  status: overall ? 'pass' : 'fail',
  stageId: 'backend-validation',
  kind: 'test',
  agent_id: Number(process.env.AID),
  total_ms: Number(process.env.TMS),
  urls: [{ label: 'sut', url: process.env.SUT }],
  scenarios,
  endpoints: results,
  bugs,
  artifacts: [{ path: '.har/artifacts/backend-validation', kind: 'directory' }],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
"

[ "$OVERALL_PASS" = "true" ] || exit 1

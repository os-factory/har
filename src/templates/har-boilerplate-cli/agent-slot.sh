#!/usr/bin/env bash
# Shared slot helpers: agent-id validation, slot registry, work-dir resolution.
# Source after harness.env (requires $SCRIPT_DIR pointing at the .har directory):
#   source "$SCRIPT_DIR/harness.env"
#   source "$SCRIPT_DIR/agent-slot.sh"
#   validate_agent_id "$AGENT_ID"

# Canonical slot limits live in stages.json (agentSlots); harness.env is legacy fallback.
har_load_agent_slot_limits() {
  local registry="${SCRIPT_DIR}/stages.json"
  if [[ -f "$registry" ]]; then
    local parsed
    parsed="$(node -e '
try {
  const slots = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).agentSlots;
  if (slots && Number.isInteger(slots.min) && Number.isInteger(slots.max)) {
    process.stdout.write(String(slots.min) + " " + String(slots.max));
  }
} catch {}
' "$registry" 2>/dev/null || true)"
    if [[ -n "$parsed" ]]; then
      HARNESS_AGENT_SLOT_MIN="${parsed%% *}"
      HARNESS_AGENT_SLOT_MAX="${parsed#* }"
      export HARNESS_AGENT_SLOT_MIN HARNESS_AGENT_SLOT_MAX
      return 0
    fi
  fi
}

har_suggest_launch() {
  local id="$1"
  echo "  Launch: har env launch ${id}     # or har_launch_environment (MCP)" >&2
  echo "  Fallback: ./.har/launch.sh ${id}  # when har CLI/MCP unavailable" >&2
}

har_suggest_status() {
  local id="${1:-}"
  echo "  Status: har env status           # or har_get_status (MCP)" >&2
  if [[ -n "$id" ]]; then
    echo "  Fallback: ./.har/agent-cli.sh ${id} status" >&2
  fi
}

validate_agent_id() {
  local id="${1:-}"
  har_load_agent_slot_limits
  local min="${HARNESS_AGENT_SLOT_MIN:-1}"
  local max="${HARNESS_AGENT_SLOT_MAX:-}"

  if [[ -z "$max" ]]; then
    echo "Error: configure agentSlots in .har/stages.json or HARNESS_AGENT_SLOT_MAX in harness.env" >&2
    exit 1
  fi

  if [[ -z "$id" ]] || ! [[ "$id" =~ ^[0-9]+$ ]]; then
    echo "Error: agent-id must be a positive integer between ${min} and ${max}" >&2
    exit 1
  fi

  if (( id < min || id > max )); then
    echo "Error: agent-id must be between ${min} and ${max}" >&2
    exit 1
  fi
}

# ── Port allocation ─────────────────────────────────────────────────────────────
# Try the configured default first; scan the slot lane or infra range when busy.

port_in_use() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && { exec 3>&- || true; return 0; }
  return 1
}

har_port_step() {
  echo "${HARNESS_PORT_STEP:-10}"
}

har_default_app_port() {
  local base="$1"
  local agent_id="$2"
  echo $(( base + agent_id * $(har_port_step) ))
}

har_slot_port_lane_end() {
  local default_port="$1"
  echo $(( default_port + $(har_port_step) - 1 ))
}

# har_pick_free_port <start> <end> — echoes the first free port in [start, end].
har_pick_free_port() {
  local start="$1"
  local end="$2"
  local port
  for ((port=start; port<=end; port++)); do
    if ! port_in_use "$port"; then
      echo "$port"
      return 0
    fi
  done
  echo "Error: no free port in range ${start}-${end}" >&2
  return 1
}

# har_allocate_port <default> <scan_start> <scan_end>
har_allocate_port() {
  local default_port="$1"
  local scan_start="$2"
  local scan_end="$3"
  if ! port_in_use "$default_port"; then
    echo "$default_port"
    return 0
  fi
  har_pick_free_port "$scan_start" "$scan_end"
}

# Allocate FE/API/DEBUG ports for a slot. Sets FE_PORT, API_PORT, DEBUG_PORT.
har_allocate_slot_app_ports() {
  local agent_id="$1"
  local step fe_default api_default debug_default
  step="$(har_port_step)"
  fe_default="$(har_default_app_port "${HARNESS_FE_BASE_PORT}" "$agent_id")"
  api_default="$(har_default_app_port "${HARNESS_API_BASE_PORT}" "$agent_id")"
  debug_default=$(( 9200 + agent_id * step ))

  FE_PORT="$(har_allocate_port "$fe_default" "$fe_default" "$(har_slot_port_lane_end "$fe_default")")"
  API_PORT="$(har_allocate_port "$api_default" "$api_default" "$(har_slot_port_lane_end "$api_default")")"
  DEBUG_PORT="$(har_allocate_port "$debug_default" "$debug_default" $(( debug_default + step - 1 )) )"
  export FE_PORT API_PORT DEBUG_PORT
}

# ── Launch preflight (#36) ─────────────────────────────────────────────────────

har_harness_uses_pm2() {
  [ -f "${SCRIPT_DIR}/ecosystem.agent.template.cjs" ]
}

har_port_docker_occupant() {
  local port="$1"
  docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
    | grep -E ":${port}->|:${port}/" | head -1 | cut -f1 || true
}

har_check_control_port_conflict() {
  local port="$1"
  local name
  name="$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
    | grep -i control | grep -E ":${port}->|:${port}/" | head -1 | cut -f1 || true)"
  if [ -n "$name" ]; then
    echo "ERROR: Mission Control container \"${name}\" occupies port ${port}." >&2
    echo "  Run: har control down — or use a different agent slot." >&2
    return 1
  fi
  return 0
}

har_check_foreign_pm2() {
  local agent_id="$1"
  local pm2_raw
  har_harness_uses_pm2 || return 0
  pm2_raw="$(npx --yes pm2 jlist 2>/dev/null || true)"
  [ -n "$pm2_raw" ] || return 0
  set +e
  echo "$pm2_raw" | node -e "
const agentId = process.argv[1];
const project = process.argv[2];
const slotPrefix = 'har-' + project + '-agent-' + agentId + '-';
const legacyPrefix = 'agent-' + agentId + '-';
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) process.exit(0);
    const foreign = arr.filter(x =>
      x.name && (
        (x.name.startsWith('har-') && x.name.includes('-agent-' + agentId + '-') && !x.name.startsWith(slotPrefix)) ||
        (x.name.startsWith(legacyPrefix) && !x.name.startsWith('har-'))
      ));
    if (foreign.length === 0) process.exit(0);
    console.error('ERROR: foreign PM2 processes match agent ' + agentId + ':');
    foreign.forEach(p => {
      const cwd = p.pm2_env?.pm_cwd || p.pm2_env?.cwd || 'unknown';
      console.error('  ' + p.name + '  cwd=' + cwd);
    });
    console.error('  Stop the other harness session or use a different slot.');
    process.exit(1);
  } catch {
    process.exit(0);
  }
});
" "$agent_id" "$HARNESS_PROJECT_NAME"
  local rc=$?
  set -e
  return "$rc"
}

# ── Resume failed launch (#38) ───────────────────────────────────────────────

slot_session_status() {
  local agent_id="$1"
  read_slot_field "$(slot_registry_file "$agent_id")" status || true
}

slot_is_resumable() {
  local agent_id="$1"
  local status
  status="$(slot_session_status "$agent_id")"
  [ "$status" = "failed" ] || [ "$status" = "starting" ]
}

har_resume_session_assignments() {
  local agent_id="$1"
  local reg work_dir worktree branch suffix base_branch base_commit purpose mode env_file

  if ! slot_is_resumable "$agent_id"; then
    local status
    status="$(slot_session_status "$agent_id")"
    echo "echo \"ERROR: slot ${agent_id} is not resumable (status=${status:-none}; need failed or starting).\" >&2" >&2
    echo "echo \"  Use a normal launch, or --replace to start a fresh session.\" >&2"
    echo 'exit 2'
    return 1
  fi

  reg="$(slot_registry_file "$agent_id")"
  work_dir="$(read_slot_field "$reg" workDir || true)"
  worktree="$(read_slot_field "$reg" worktreePath || true)"
  branch="$(read_slot_field "$reg" branch || true)"
  suffix="$(read_slot_field "$reg" suffix || true)"
  base_branch="$(read_slot_field "$reg" baseBranch || true)"
  base_commit="$(read_slot_field "$reg" baseCommit || true)"
  purpose="$(read_slot_field "$reg" purpose || true)"
  mode="$(read_slot_field "$reg" mode || true)"

  if [ -z "$work_dir" ] || [ ! -d "$work_dir" ]; then
    echo "echo \"ERROR: resume requires work dir from registry (missing or not found).\" >&2"
    echo 'exit 1'
    return 1
  fi

  env_file="$work_dir/.env.agent.${agent_id}"
  if [ ! -f "$env_file" ]; then
    echo "echo \"ERROR: resume requires env file: ${env_file}\" >&2"
    echo 'exit 1'
    return 1
  fi

  printf '%s\n' \
    "WORK_DIR='${work_dir}'" \
    "WORKTREE_DIR='${worktree}'" \
    "BRANCH='${branch}'" \
    "SUFFIX='${suffix}'" \
    "BASE_BRANCH='${base_branch}'" \
    "BASE_COMMIT='${base_commit}'" \
    "PURPOSE='${purpose}'" \
    "USE_WORKTREE=$([ "$mode" = worktree ] && echo true || echo false)" \
    "ENV_FILE='${env_file}'"
}

har_toolchain_ready() {
  local work_dir="$1"
  if [ -f "$work_dir/package.json" ] && [ -d "$work_dir/node_modules" ]; then
    return 0
  fi
  if [ -d "$work_dir/.har/venv" ]; then
    return 0
  fi
  return 1
}

har_regenerate_agent_env_file() {
  local agent_id="$1"
  local work_dir="$2"
  local env_file="$3"
  local worktree_dir="${4:-}"
  local template="${SCRIPT_DIR}/env.template"
  if [ -f "$template" ]; then
    AGENT_ID="$agent_id" \
    API_PORT="${API_PORT:-}" \
    FE_PORT="${FE_PORT:-}" \
    DEBUG_PORT="${DEBUG_PORT:-}" \
    DB_PORT="${DB_PORT:-${AGENT_DB_PORT:-${HARNESS_DB_PORT_DEFAULT:-15432}}}" \
    MINIO_PORT="${MINIO_PORT:-${AGENT_MINIO_PORT:-${HARNESS_MINIO_PORT_DEFAULT:-19000}}}" \
    BROWSER_PORT="${BROWSER_PORT:-${AGENT_BROWSER_PORT:-${HARNESS_BROWSER_PORT_DEFAULT:-13001}}}" \
    REPO_ROOT="$work_dir" \
      envsubst '${AGENT_ID} ${API_PORT} ${FE_PORT} ${DEBUG_PORT} ${DB_PORT} ${MINIO_PORT} ${BROWSER_PORT} ${REPO_ROOT}' \
      < "$template" > "$env_file"
  else
    cat > "$env_file" <<EOF
# Agent environment — generated by launch.sh
AGENT_ID=${agent_id}
REPO_ROOT=${work_dir}
WORKTREE_DIR=${worktree_dir}
NODE_ENV=test
EOF
  fi
  if command -v har >/dev/null 2>&1; then
    har telemetry write-env \
      --agent-id "$agent_id" \
      --repo "${HARNESS_ROOT:-$REPO_ROOT}" \
      --env-file "$env_file" \
      --work-dir "$work_dir" \
      ${SLOT_BRANCH:+--branch "$SLOT_BRANCH"} \
      ${SLOT_SUFFIX:+--suffix "$SLOT_SUFFIX"} \
      ${SLOT_PURPOSE:+--purpose "$SLOT_PURPOSE"} \
      >/dev/null 2>&1 || true
  fi
}

har_launch_preflight() {
  local agent_id="$1"
  local force="${2:-false}"
  local replace="${3:-false}"
  local resume="${4:-false}"

  if [ "$resume" = true ]; then
    if ! slot_is_resumable "$agent_id"; then
      local status
      status="$(slot_session_status "$agent_id")"
      echo "ERROR: slot ${agent_id} is not resumable (status=${status:-none}; need failed or starting)." >&2
      echo "  Use a normal launch, or --replace to start a fresh session." >&2
      return 2
    fi
    echo "==> [agent-${agent_id}] Resuming partial launch (worktree and deps preserved)..." >&2
  elif slot_is_occupied "$agent_id"; then
    if [ "$replace" != true ] && [ "${HAR_CONFIRM_REPLACE:-}" != "1" ]; then
      print_slot_replace_warning "$agent_id"
      echo "ERROR: slot ${agent_id} is occupied — pass --replace to proceed." >&2
      return 2
    fi
    local wt
    wt="$(existing_slot_worktree "$agent_id")"
    if [ -n "$wt" ] && slot_worktree_dirty "$wt" && [ "$force" != true ]; then
      echo "ERROR: dirty worktree requires --force after explicit user approval." >&2
      return 2
    fi
  fi

  if har_harness_uses_pm2; then
    har_check_foreign_pm2 "$agent_id" || return 1
    har_allocate_slot_app_ports "$agent_id" || return 1
    local port occupant
    for port in $(printf '%s\n' "$FE_PORT" "$API_PORT" | sort -u); do
      har_check_control_port_conflict "$port" || return 1
      occupant="$(har_port_docker_occupant "$port")"
      if [ -n "$occupant" ] && [[ "$occupant" != har-${HARNESS_PROJECT_NAME}-* ]]; then
        echo "ERROR: Docker container \"${occupant}\" binds port ${port}." >&2
        echo "  Stop it with: docker stop ${occupant}" >&2
        return 1
      fi
    done
  fi
  return 0
}

# Load persisted app/infra ports from .env.agent.<id> or the slot registry.
load_agent_ports() {
  local agent_id="$1"
  local repo_root="$2"
  local env_file reg ports_json
  env_file="$(resolve_agent_env_file "$agent_id" "$repo_root" 2>/dev/null || true)"
  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    # shellcheck source=/dev/null
    source "$env_file"
    FE_PORT="${FE_PORT:-}"
    API_PORT="${API_PORT:-${PORT:-}}"
    DEBUG_PORT="${DEBUG_PORT:-}"
    DB_PORT="${PGPORT:-${DB_PORT:-}}"
    return 0
  fi
  reg="$(slot_registry_file "$agent_id")"
  if [ -f "$reg" ]; then
    ports_json="$(node -e '
try {
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ports;
  if (p) process.stdout.write(JSON.stringify(p));
} catch {}
' "$reg" 2>/dev/null || true)"
    if [ -n "$ports_json" ]; then
      FE_PORT="$(node -e "const p=JSON.parse(process.argv[1]);process.stdout.write(String(p.frontend??''))" "$ports_json")"
      API_PORT="$(node -e "const p=JSON.parse(process.argv[1]);process.stdout.write(String(p.api??''))" "$ports_json")"
      DEBUG_PORT="$(node -e "const p=JSON.parse(process.argv[1]);process.stdout.write(String(p.debug??''))" "$ports_json")"
      DB_PORT="$(node -e "const p=JSON.parse(process.argv[1]);process.stdout.write(String(p.db??''))" "$ports_json")"
      export FE_PORT API_PORT DEBUG_PORT DB_PORT
      return 0
    fi
  fi
  har_allocate_slot_app_ports "$agent_id"
  DB_PORT="${AGENT_DB_PORT:-${HARNESS_DB_PORT_DEFAULT:-15432}}"
  export FE_PORT API_PORT DEBUG_PORT DB_PORT
}

# ── Project-scoped PM2 names ────────────────────────────────────────────────────
# Pattern: har-<project>-agent-<id>-<service> (machine-global PM2 namespace).

har_pm2_slot_prefix() {
  echo "har-${HARNESS_PROJECT_NAME}-agent-${1}"
}

har_pm2_delete_regex() {
  echo "/^har-${HARNESS_PROJECT_NAME}-agent-${1}-/"
}

har_tmux_session() {
  echo "har-${HARNESS_PROJECT_NAME}-agent-${1}"
}

# ── Slot registry ─────────────────────────────────────────────────────────────
# .har/slots/agent-<id>.json is the source of truth for where a session lives
# (worktree path, work dir, branch, base commit). Written by launch.sh, removed
# by teardown.sh. Location resolution must go through it — worktree paths carry
# a random per-session suffix and cannot be derived from the agent id alone.

slot_registry_file() {
  echo "${SCRIPT_DIR}/slots/agent-${1}.json"
}

# read_slot_field <registry-file> <field> — echoes the scalar value, empty if absent.
read_slot_field() {
  [ -f "${1:-}" ] || return 1
  node -e '
try {
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
  if (v != null && typeof v !== "object") process.stdout.write(String(v));
} catch {}
' "$1" "$2"
}

# Writes the registry entry from SLOT_* variables:
#   required: SLOT_AGENT_ID, SLOT_MODE (worktree|root), SLOT_WORK_DIR
#   optional: SLOT_SUFFIX, SLOT_WORKTREE_PATH, SLOT_BRANCH, SLOT_BASE_BRANCH,
#             SLOT_BASE_COMMIT, SLOT_PORTS_JSON, SLOT_PREVIEW_URLS_JSON,
#             SLOT_PURPOSE, SLOT_STATUS, SLOT_LAST_ERROR
write_slot_registry() {
  local file
  file="$(slot_registry_file "$SLOT_AGENT_ID")"
  mkdir -p "$(dirname "$file")"
  node -e '
const fs = require("fs");
const e = process.env;
const entry = {
  version: 1,
  agentId: Number(e.SLOT_AGENT_ID),
  projectName: e.HARNESS_PROJECT_NAME || "",
  mode: e.SLOT_MODE,
  workDir: e.SLOT_WORK_DIR,
  createdAt: new Date().toISOString(),
  status: e.SLOT_STATUS || "active",
};
if (e.SLOT_SUFFIX) entry.suffix = e.SLOT_SUFFIX;
if (e.SLOT_WORKTREE_PATH) entry.worktreePath = e.SLOT_WORKTREE_PATH;
if (e.SLOT_BRANCH) entry.branch = e.SLOT_BRANCH;
if (e.SLOT_BASE_BRANCH) entry.baseBranch = e.SLOT_BASE_BRANCH;
if (e.SLOT_BASE_COMMIT) entry.baseCommit = e.SLOT_BASE_COMMIT;
if (e.SLOT_PURPOSE) entry.purpose = e.SLOT_PURPOSE;
if (e.SLOT_LAST_ERROR) entry.lastError = e.SLOT_LAST_ERROR;
for (const [key, env] of [["ports", "SLOT_PORTS_JSON"], ["previewUrls", "SLOT_PREVIEW_URLS_JSON"]]) {
  if (e[env]) try { entry[key] = JSON.parse(e[env]); } catch {}
}
fs.writeFileSync(process.argv[1], JSON.stringify(entry, null, 2) + "\n");
' "$file"
}

remove_slot_registry() {
  rm -f "$(slot_registry_file "$1")"
}

# Exit 0 when the worktree has uncommitted or untracked changes.
slot_worktree_dirty() {
  [ -d "${1:-}" ] || return 1
  [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]
}

# Exit 0 when a slot registry entry or worktree path exists for this agent id.
slot_is_occupied() {
  local agent_id="$1"
  [ -f "$(slot_registry_file "$agent_id")" ] || [ -n "$(existing_slot_worktree "$agent_id")" ]
}

# Echo "clean" or "dirty (N changed)" for a worktree path.
slot_dirty_summary() {
  local wt="${1:-}"
  if [ -z "$wt" ] || [ ! -d "$wt" ]; then
    echo "unknown"
    return 0
  fi
  if ! slot_worktree_dirty "$wt"; then
    echo "clean"
    return 0
  fi
  local count
  count="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "dirty (${count} changed)"
}

# Print a warning before replacing an occupied slot (stdout — visible to agents).
print_slot_replace_warning() {
  local agent_id="$1"
  local reg wt branch work_dir purpose created status last_error dirty_summary head
  reg="$(slot_registry_file "$agent_id")"
  wt="$(existing_slot_worktree "$agent_id")"
  branch="$(read_slot_field "$reg" branch || true)"
  work_dir="$(read_slot_field "$reg" workDir || true)"
  purpose="$(read_slot_field "$reg" purpose || true)"
  created="$(read_slot_field "$reg" createdAt || true)"
  status="$(read_slot_field "$reg" status || true)"
  last_error="$(read_slot_field "$reg" lastError || true)"
  dirty_summary="$(slot_dirty_summary "$wt")"
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    head="$(git -C "$wt" rev-parse --short HEAD 2>/dev/null || true)"
  fi

  echo "" >&2
  echo "⚠ Slot ${agent_id} is already in use — replacing will REMOVE the worktree." >&2
  [ -n "$purpose" ] && echo "  Purpose:   ${purpose}" >&2
  [ -n "$wt" ] && echo "  Worktree:  ${wt}" >&2
  [ -n "$work_dir" ] && echo "  Work dir:  ${work_dir}" >&2
  [ -n "$branch" ] && echo "  Branch:    ${branch}${head:+ @ ${head}}" >&2
  [ -n "$status" ] && echo "  Status:    ${status}" >&2
  [ -n "$last_error" ] && echo "  Error:     ${last_error}" >&2
  [ -n "$created" ] && echo "  Since:     ${created}" >&2
  echo "  Git:       ${dirty_summary}" >&2
  echo "" >&2
  echo "  The session branch is kept only if you committed. Gitignored paths" >&2
  echo "  (state/, runs/, local clones, .env.local) are NOT preserved." >&2
  echo "" >&2
}

# Require explicit confirmation before replacing an occupied slot.
#   $1 agent_id  $2 force(true/false)  $3 replace(true/false)
# Exits 1 when replacement must not proceed.
require_slot_replace_confirm() {
  local agent_id="$1"
  local force="$2"
  local replace="$3"
  local wt

  slot_is_occupied "$agent_id" || return 0

  print_slot_replace_warning "$agent_id"
  wt="$(existing_slot_worktree "$agent_id")"

  if [ -n "$wt" ] && slot_worktree_dirty "$wt" && [ "$force" != true ]; then
    echo "ERROR: previous session for slot ${agent_id} has uncommitted changes." >&2
    echo "  Commit them in the worktree (branch is kept on teardown), or pass --force to discard." >&2
    echo "  --force destroys uncommitted work — only use after explicit user approval." >&2
    exit 1
  fi

  if [ "$replace" = true ] || [ "${HAR_CONFIRM_REPLACE:-}" = "1" ]; then
    return 0
  fi

  if [ -t 0 ] && [ -t 1 ]; then
    local answer
    read -r -p "Replace slot ${agent_id}? Uncommitted work is lost unless committed. [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      return 0
    fi
    echo "Aborted — slot ${agent_id} left unchanged." >&2
    exit 2
  fi

  echo "ERROR: slot ${agent_id} is occupied." >&2
  echo "  Pass --replace (or set HAR_CONFIRM_REPLACE=1) after reviewing the warning above." >&2
  echo "  If the worktree is dirty, also pass --force (only after explicit user approval)." >&2
  exit 2
}

git_common_dir() {
  local cwd="$1"
  local out
  out="$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null)" || return 1
  case "$out" in
    /*) echo "$out" ;;
    *) (cd "$cwd" && cd "$out" && pwd) ;;
  esac
}

same_git_checkout() {
  local left right
  left="$(git_common_dir "$1" || true)"
  right="$(git_common_dir "$2" || true)"
  [ -n "$left" ] && [ -n "$right" ] && [ "$left" = "$right" ]
}

# Echo the previous session's worktree path for a slot: registry first, then
# legacy and randomized session worktree fallbacks. Empty output when none exists.
existing_slot_worktree() {
  local agent_id="$1"
  local reg path candidate repo_root rel_prefix
  repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  rel_prefix="$(git -C "$repo_root" rev-parse --show-prefix 2>/dev/null || true)"
  reg="$(slot_registry_file "$agent_id")"
  if [ -f "$reg" ]; then
    path="$(read_slot_field "$reg" worktreePath || true)"
    if [ -n "$path" ] && [ -d "$path" ]; then
      echo "$path"
      return 0
    fi
  fi
  path="$HOME/worktrees/${HARNESS_PROJECT_NAME}-agent-${agent_id}"
  if [ -d "$path" ]; then
    echo "$path"
    return 0
  fi
  for candidate in "$HOME"/worktrees/*-har-agent-"${agent_id}"-*; do
    [ -d "$candidate" ] || continue
    same_git_checkout "$repo_root" "$candidate" || continue
    [ -f "$candidate/${rel_prefix}.env.agent.${agent_id}" ] || continue
    echo "$candidate"
    return 0
  done
  return 0
}

# Resolve .env.agent.<id> — registry work dir first, then legacy and
# randomized session worktree fallbacks.
resolve_agent_env_file() {
  local agent_id="$1"
  local repo_root="$2"
  local reg work_dir
  reg="$(slot_registry_file "$agent_id")"
  if [ -f "$reg" ]; then
    work_dir="$(read_slot_field "$reg" workDir || true)"
    if [ -n "$work_dir" ] && [ -f "$work_dir/.env.agent.${agent_id}" ]; then
      echo "$work_dir/.env.agent.${agent_id}"
      return 0
    fi
  fi
  # Worktrees are repo-rooted — if the project lives in a subdirectory (monorepo),
  # the env file sits under that prefix inside the worktree.
  local rel_prefix
  rel_prefix="$(git -C "$repo_root" rev-parse --show-prefix 2>/dev/null || true)"
  local candidate
  for candidate in \
    "$repo_root/.env.agent.${agent_id}" \
    "$HOME/worktrees/${HARNESS_PROJECT_NAME}-agent-${agent_id}/${rel_prefix}.env.agent.${agent_id}"; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  local candidate_dir
  for candidate in "$HOME"/worktrees/*-har-agent-"${agent_id}"-*/${rel_prefix}.env.agent."${agent_id}"; do
    if [ -f "$candidate" ]; then
      candidate_dir="$(cd "$(dirname "$candidate")" && pwd)"
      same_git_checkout "$repo_root" "$candidate_dir" || continue
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# Resolve work dir for verify/e2e — registry first, else the agent env file's
# variables (call after sourcing the env file). Optional 2nd arg: agent id.
resolve_agent_work_dir() {
  local env_file="$1"
  local agent_id="${2:-${AGENT_ID:-}}"
  if [ -n "$agent_id" ]; then
    local reg wd
    reg="$(slot_registry_file "$agent_id")"
    if [ -f "$reg" ]; then
      wd="$(read_slot_field "$reg" workDir || true)"
      if [ -n "$wd" ] && [ -d "$wd" ]; then
        echo "$wd"
        return 0
      fi
    fi
  fi
  local work_dir="${REPO_ROOT:-}"
  if [ -z "$work_dir" ] || [ ! -d "$work_dir" ]; then
    if [ -n "${WORKTREE_DIR:-}" ] && [ -d "$WORKTREE_DIR" ]; then
      work_dir="$WORKTREE_DIR"
    else
      work_dir="$(cd "$(dirname "$env_file")" && pwd)"
    fi
  fi
  echo "$work_dir"
}

# Portable millisecond clock (GNU date %N is unavailable on macOS/BSD).
now_ms() {
  node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0
}

# JSON-escape step output; truncate to 50 lines in node (avoids SIGPIPE under pipefail).
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(0,50).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}

# Emit "<id>\t<command>" for each registered stage listed in stages.json
# verificationStages (used by verify --full). Ids without a matching registered
# stage are inline verify.sh steps and skipped here; lifecycle stages
# (setup/launch/reset/teardown/inspect) and the verify stage itself never run.
# Authoring contract: .har/STAGES.md
list_registered_verification_stage_commands() {
  local script_dir="$1"
  local agent_id="$2"
  local registry="$script_dir/stages.json"
  [ -f "$registry" ] || return 0
  HAR_STAGE_REGISTRY="$registry" HAR_SCRIPT_DIR="$script_dir" HAR_AGENT_ID="$agent_id" node <<'NODE' 2>/dev/null || true
const fs = require('fs');
const { HAR_STAGE_REGISTRY, HAR_SCRIPT_DIR, HAR_AGENT_ID } = process.env;
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
let reg;
try { reg = JSON.parse(fs.readFileSync(HAR_STAGE_REGISTRY, 'utf8')); } catch { process.exit(0); }
const ids = Array.isArray(reg.verificationStages) ? reg.verificationStages : [];
const stages = Array.isArray(reg.stages) ? reg.stages : [];
const runnable = new Set(['test', 'custom']);
for (const id of ids) {
  const stage = stages.find((s) => s && s.id === id);
  if (!stage || stage.id === 'verify' || !runnable.has(stage.kind)) continue;
  const needsAgent = stage.requiresAgentId !== false;
  let cmd;
  if (stage.script) {
    cmd = shq(HAR_SCRIPT_DIR + '/' + stage.script) + (needsAgent ? ' ' + shq(HAR_AGENT_ID) : '');
  } else if (stage.command) {
    cmd = stage.command.split('{agentId}').join(HAR_AGENT_ID);
  } else {
    continue;
  }
  if (stage.cwd) cmd = 'cd ' + shq(stage.cwd) + ' && ' + cmd;
  const env = stage.env && typeof stage.env === 'object' ? stage.env : {};
  const prefix = Object.entries(env).map(([k, v]) => k + '=' + shq(v)).join(' ');
  process.stdout.write(id + '\t' + (prefix ? prefix + ' ' : '') + cmd + '\n');
}
NODE
}

# Optional project-owned "agent usable" smoke beyond health.
run_readiness_if_configured() {
  local agent_id="$1"
  if [ -z "${HARNESS_READINESS_CMD:-}" ]; then
    echo "No HARNESS_READINESS_CMD configured; skipping readiness smoke."
    return 0
  fi
  local cmd="${HARNESS_READINESS_CMD//\{agentId\}/$agent_id}"
  eval "$cmd"
}

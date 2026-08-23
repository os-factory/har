#!/usr/bin/env bash
# Shared slot helpers: agent-id validation, slot registry, work-dir resolution.
# Source after harness.env (requires $SCRIPT_DIR pointing at the .har directory):
#   source "$SCRIPT_DIR/harness.env"
#   source "$SCRIPT_DIR/agent-slot.sh"
#   validate_agent_id "$AGENT_ID"

# Node package-manager helpers (har_node_*, har_pkg_exec) are single-sourced
# from lib/node-pm.sh so every .har script and provision-toolchain.sh resolve
# the same tool.
# shellcheck source=/dev/null
if [ -f "${SCRIPT_DIR:-}/lib/node-pm.sh" ]; then
  source "${SCRIPT_DIR}/lib/node-pm.sh"
fi

# Infra helpers (har_infra_enabled, har_pg, har_infra_port_lane) are
# single-sourced from lib/infra.sh — harness.env is pure KEY=value config.
# shellcheck source=/dev/null
if [ -f "${SCRIPT_DIR:-}/lib/infra.sh" ]; then
  source "${SCRIPT_DIR}/lib/infra.sh"
fi

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
    echo "Error: invalid agent slot id: ${id:-"(missing)"}" >&2
    echo "  Must be an integer between ${min} and ${max} (see .har/stages.json → agentSlots)" >&2
    exit 1
  fi

  if (( id < min || id > max )); then
    echo "Error: invalid agent slot id: ${id}" >&2
    echo "  Valid slots: ${min}–${max} (configured in .har/stages.json → agentSlots)" >&2
    echo "  Run: har env status   # see which slots are in use" >&2
    if (( id > max )); then
      echo "  To allow slot ${id}, raise agentSlots.max in .har/stages.json." >&2
    fi
    exit 1
  fi
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
#             SLOT_STATUS, SLOT_LAST_ERROR, SLOT_WORK_UNIT_ID, SLOT_ATTEMPT_ID
# Mission Control re-reads slot state only when something syncs, and a sync takes
# about twenty seconds — too long to make a slot change wait for it. Detached, and
# coalesced so a run of slot changes leaves one sync going, then one more if needed.
har_notify_control() {
  local root bin lock
  root="$(cd "${SCRIPT_DIR}/.." && pwd)"
  bin="$(command -v har 2>/dev/null || echo "${root}/node_modules/.bin/har")"
  [ -x "$bin" ] || return 0

  lock="${TMPDIR:-/tmp}/har-control-sync.$(id -u)"
  : > "${lock}.pending"
  mkdir "$lock" 2>/dev/null || return 0
  (
    trap "" HUP
    trap 'rmdir "$lock" 2>/dev/null || true' EXIT
    cd "$root" || exit 0
    while [ -f "${lock}.pending" ]; do
      rm -f "${lock}.pending"
      if command -v timeout >/dev/null 2>&1; then
        timeout 120 "$bin" control sync || true
      else
        "$bin" control sync || true
      fi
    done
  # Redirected as a whole, not per command: a background job that keeps the inherited
  # stdout open makes any caller reading that pipe wait for it.
  ) >/dev/null 2>&1 &
}

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
if (e.SLOT_LAST_ERROR) entry.lastError = e.SLOT_LAST_ERROR;
if (e.SLOT_WORK_UNIT_ID) entry.workUnitId = e.SLOT_WORK_UNIT_ID;
if (e.SLOT_ATTEMPT_ID) entry.attemptId = e.SLOT_ATTEMPT_ID;
for (const [key, env] of [["ports", "SLOT_PORTS_JSON"], ["previewUrls", "SLOT_PREVIEW_URLS_JSON"]]) {
  if (e[env]) try { entry[key] = JSON.parse(e[env]); } catch {}
}
fs.writeFileSync(process.argv[1], JSON.stringify(entry, null, 2) + "\n");
' "$file"
  har_notify_control
}

remove_slot_registry() {
  rm -f "$(slot_registry_file "$1")"
  har_notify_control
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

# Print details about an occupied slot (stdout — visible to agents).
print_slot_occupied_warning() {
  local agent_id="$1"
  local reg wt branch work_dir created status last_error dirty_summary head
  reg="$(slot_registry_file "$agent_id")"
  wt="$(existing_slot_worktree "$agent_id")"
  branch="$(read_slot_field "$reg" branch || true)"
  work_dir="$(read_slot_field "$reg" workDir || true)"
  created="$(read_slot_field "$reg" createdAt || true)"
  status="$(read_slot_field "$reg" status || true)"
  last_error="$(read_slot_field "$reg" lastError || true)"
  dirty_summary="$(slot_dirty_summary "$wt")"
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    head="$(git -C "$wt" rev-parse --short HEAD 2>/dev/null || true)"
  fi

  echo "" >&2
  echo "⚠ Slot ${agent_id} is already in use." >&2
  [ -n "$wt" ] && echo "  Worktree:  ${wt}" >&2
  [ -n "$work_dir" ] && echo "  Work dir:  ${work_dir}" >&2
  [ -n "$branch" ] && echo "  Branch:    ${branch}${head:+ @ ${head}}" >&2
  [ -n "$status" ] && echo "  Status:    ${status}" >&2
  [ -n "$last_error" ] && echo "  Error:     ${last_error}" >&2
  [ -n "$created" ] && echo "  Since:     ${created}" >&2
  echo "  Git:       ${dirty_summary}" >&2
  echo "" >&2
  local base_root="${HARNESS_ROOT:-${REPO_ROOT:-}}"
  if [ -n "$base_root" ] && [ -d "$base_root" ]; then
    local base_branch base_sha
    base_branch="$(git -C "$base_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
    base_sha="$(git -C "$base_root" rev-parse --short HEAD 2>/dev/null || true)"
    echo "  New session will be based on: ${base_branch}${base_sha:+ @ ${base_sha}}" >&2
    echo "  (HEAD of ${base_root})" >&2
    echo "  Switch that checkout to your intended base before launching a new session." >&2
    echo "" >&2
  fi
  if [ "$dirty_summary" != "clean" ] && [ "$dirty_summary" != "unknown" ]; then
    echo "  Commit or discard changes in the worktree, then teardown/complete the slot:" >&2
  else
    echo "  Free the slot, then launch again:" >&2
  fi
  echo "    har env complete ${agent_id}   # or: har env teardown ${agent_id}" >&2
  echo "    har env launch ${agent_id}" >&2
  echo "" >&2
  echo "  complete/teardown remove the worktree. The session branch is kept only if" >&2
  echo "  you committed. Gitignored paths (state/, runs/, local clones, .env.local)" >&2
  echo "  are NOT preserved." >&2
  echo "" >&2
}

# Untracked (not ignored) paths stay in the main checkout when a session
# worktree is created from HEAD. Advisory — never fails the launch.
har_warn_untracked_worktree() {
  case "${USE_WORKTREE:-${HARNESS_USE_WORKTREE:-true}}" in
    true|TRUE|yes|YES|1) ;;
    *) return 0 ;;
  esac
  local root="${REPO_ROOT:-}"
  if [ -z "$root" ] && [ -n "${SCRIPT_DIR:-}" ]; then
    root="$(cd "$SCRIPT_DIR/.." && pwd)"
  fi
  [ -n "$root" ] || return 0
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  local paths=()
  local entry
  while IFS= read -r -d '' entry; do
    paths+=("$entry")
  done < <(git -C "$root" --literal-pathspecs ls-files --others --exclude-standard --directory -z 2>/dev/null || true)

  local count="${#paths[@]}"
  [ "$count" -gt 0 ] || return 0

  local max=8
  local listed=""
  local i
  for ((i = 0; i < count && i < max; i++)); do
    [ -n "$listed" ] && listed+=", "
    listed+="${paths[$i]}"
  done
  if [ "$count" -gt "$max" ]; then
    listed+=" (+$((count - max)) more)"
  fi

  local noun="paths"
  local them="They are"
  if [ "$count" -eq 1 ]; then
    noun="path"
    them="It is"
  fi
  echo "WARN: ${count} untracked ${noun} will not appear in the session worktree: ${listed}. ${them} only in the main checkout — track them, or launch with --no-worktree." >&2
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

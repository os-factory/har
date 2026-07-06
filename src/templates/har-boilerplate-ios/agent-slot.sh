#!/usr/bin/env bash
# Shared slot helpers: agent-id validation, slot registry, work-dir resolution.
# Source after harness.env (requires $SCRIPT_DIR pointing at the .har directory):
#   source "$SCRIPT_DIR/harness.env"
#   source "$SCRIPT_DIR/agent-slot.sh"
#   validate_agent_id "$AGENT_ID"

validate_agent_id() {
  local id="${1:-}"
  local min="${HARNESS_AGENT_SLOT_MIN:-1}"
  local max="${HARNESS_AGENT_SLOT_MAX:-}"

  if [[ -z "$max" ]]; then
    echo "Error: HARNESS_AGENT_SLOT_MAX is not set in harness.env" >&2
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
#             SLOT_BASE_COMMIT, SLOT_PORTS_JSON, SLOT_PREVIEW_URLS_JSON
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
  status: "active",
};
if (e.SLOT_SUFFIX) entry.suffix = e.SLOT_SUFFIX;
if (e.SLOT_WORKTREE_PATH) entry.worktreePath = e.SLOT_WORKTREE_PATH;
if (e.SLOT_BRANCH) entry.branch = e.SLOT_BRANCH;
if (e.SLOT_BASE_BRANCH) entry.baseBranch = e.SLOT_BASE_BRANCH;
if (e.SLOT_BASE_COMMIT) entry.baseCommit = e.SLOT_BASE_COMMIT;
for (const [key, env] of [["ports", "SLOT_PORTS_JSON"], ["previewUrls", "SLOT_PREVIEW_URLS_JSON"]]) {
  if (e[env]) try { entry[key] = JSON.parse(e[env]); } catch {}
}
fs.writeFileSync(process.argv[1], JSON.stringify(entry, null, 2) + "\n");
' "$file"
}

remove_slot_registry() {
  rm -f "$(slot_registry_file "$1")"
}

# Exit 0 when the worktree has uncommitted changes.
slot_worktree_dirty() {
  [ -d "${1:-}" ] || return 1
  [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]
}

# Echo the previous session's worktree path for a slot: registry first, then
# the legacy fixed path (pre-registry sessions). Empty output when none exists.
existing_slot_worktree() {
  local agent_id="$1"
  local reg path
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
  fi
  return 0
}

# Resolve .env.agent.<id> — registry work dir first, then legacy locations
# (repo root, pre-registry fixed worktree path).
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
  return 1
}

# Resolve work dir for verify/flows — registry first, else the agent env file's
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

# Run rocketsim-flows on verify --full when the RocketSim stage template is installed.
# See: .har/stages/rocketsim-flows.sh and .har/stages/ROCKETSIM.md
run_rocketsim_flows_if_present() {
  local script_dir="$1"
  local agent_id="$2"
  local flows_runner="$script_dir/stages/rocketsim-flows.sh"
  if [ -x "$flows_runner" ]; then
    "$flows_runner" "$agent_id"
  fi
}

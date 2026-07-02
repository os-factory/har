#!/usr/bin/env bash
# Validates agent-id against HARNESS_AGENT_SLOT_MIN/MAX from harness.env.
# Source after harness.env:
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

# Resolve .env.agent.<id> in repo root or git worktree (after sourcing harness.env).
resolve_agent_env_file() {
  local agent_id="$1"
  local repo_root="$2"
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
  return 1
}

# Resolve work dir for verify/e2e — call after sourcing the agent env file.
resolve_agent_work_dir() {
  local env_file="$1"
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

# Run browser-e2e on verify --full when the Playwright stage template is installed.
run_browser_e2e_if_present() {
  local script_dir="$1"
  local agent_id="$2"
  local e2e="$script_dir/stages/browser-e2e.sh"
  if [ -x "$e2e" ]; then
    "$e2e" "$agent_id"
  fi
}

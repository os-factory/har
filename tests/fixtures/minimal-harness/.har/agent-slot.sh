#!/usr/bin/env bash
# Validates agent-id — stages.json agentSlots is canonical; harness.env is fallback.

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

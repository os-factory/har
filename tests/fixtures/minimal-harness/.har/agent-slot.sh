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

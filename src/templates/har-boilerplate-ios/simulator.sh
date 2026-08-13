#!/usr/bin/env bash
# Per-slot iOS Simulator allocation.
#
# One booted simulator shared by every agent slot means concurrent xcodebuild
# destinations, installs of the same bundle id, and UI flows collide. Each slot
# instead gets a simulator of its own, created at launch and deleted at teardown:
# unique by construction, pristine on every launch, and never a device the
# developer is using by hand.
#
# Source AFTER harness.env and agent-slot.sh — read_slot_field, slot_registry_file
# and SCRIPT_DIR come from there.
#
# What a slot holds is recorded in .har/simulators/agent-<id>.json, so teardown
# knows whether the device was HAR's to delete.

# ── Configuration ─────────────────────────────────────────────────────────────

# Preferred device family: auto (infer from HARNESS_SIMULATOR_NAME) | iPhone | iPad
har_sim_preferred_family() {
  local configured="${HARNESS_SIMULATOR_FAMILY:-auto}"
  case "$configured" in
    iPhone|iPad) echo "$configured"; return ;;
  esac
  case "${HARNESS_SIMULATOR_NAME:-}" in
    iPad*|iPAD*|ipad*) echo "iPad" ;;
    *) echo "iPhone" ;;
  esac
}

har_sim_per_slot_enabled() {
  [ "${HARNESS_SIMULATOR_SHARED:-false}" != "true" ]
}

har_sim_log() { echo "==> simulator: $*" >&2; }

# "iPad Air 11-inch (M4)" → "iPad-Air-11-inch-M4"
har_sim_slug() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-' | tr -s '-' | sed 's/^-//; s/-$//'
}

# Short digest of the repository path. Two checkouts can share a folder name,
# and therefore HARNESS_PROJECT_NAME, but not a path — without it the prefix
# sweep below would delete the other checkout's live device.
har_sim_repo_digest() {
  local repo
  # -P so the same checkout reached through a symlink yields the same digest.
  repo="$(cd -P "${SCRIPT_DIR}/.." 2>/dev/null && pwd -P || echo "${SCRIPT_DIR}")"
  node -e 'process.stdout.write(require("crypto").createHash("sha1").update(process.argv[1]).digest("hex").slice(0, 6))' "$repo"
}

# Stable part of a slot's device name. The model is appended after it, so a
# device left over from a launch on another model is still recognised as this
# slot's and cleaned up.
har_sim_device_label_prefix() {
  echo "har-$(har_sim_slug "${HARNESS_PROJECT_NAME:-har}")-$(har_sim_repo_digest)-agent-${1}"
}

har_sim_device_label() {
  local prefix model
  prefix="$(har_sim_device_label_prefix "$1")"
  model="$(har_sim_slug "${2:-}")"
  [ -n "$model" ] && echo "${prefix}-${model}" || echo "$prefix"
}

# ── Claims ────────────────────────────────────────────────────────────────────
# Slots never compete for a device, so a claim only records what teardown must
# release — no locking, no cross-slot exclusion.

har_sim_claims_dir() { echo "${SCRIPT_DIR}/simulators"; }
har_sim_claim_file() { echo "$(har_sim_claims_dir)/agent-${1}.json"; }

har_sim_write_claim() {
  local agent_id="$1" udid="$2" name="$3" created="$4" file
  file="$(har_sim_claim_file "$agent_id")"
  mkdir -p "$(dirname "$file")"
  node -e '
const fs = require("fs");
const [file, agentId, udid, name, created] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({
  agentId: Number(agentId),
  udid,
  name,
  createdByHar: created === "true",
  claimedAt: new Date().toISOString(),
}, null, 2) + "\n");
' "$file" "$agent_id" "$udid" "$name" "$created"
}

# Agent id of another live slot holding this udid, if any. Only a pinned
# HARNESS_SIMULATOR_UDID can produce that overlap.
har_sim_claim_owner_of() {
  local udid="$1" self="$2" dir file id
  dir="$(har_sim_claims_dir)"
  [ -d "$dir" ] || return 0
  for file in "$dir"/agent-*.json; do
    [ -f "$file" ] || continue
    id="$(basename "$file")"
    id="${id#agent-}"
    id="${id%.json}"
    [ "$id" = "$self" ] && continue
    [ -f "$(slot_registry_file "$id")" ] || continue
    if [ "$(read_slot_field "$file" udid || true)" = "$udid" ]; then
      echo "$id"
      return 0
    fi
  done
}

# ── Device discovery ──────────────────────────────────────────────────────────

# Every simctl call goes through here, so "simctl could not be asked" stays
# distinguishable from "simctl answered, and the answer is empty" at the one place
# that still knows the difference. Non-zero means the first; callers check it
# instead of reading an empty list as a fact about the machine.
har_sim_simctl() {
  local out rc=0
  out="$(xcrun simctl "$@" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    return 1
  fi
  printf '%s' "$out"
}

# Unavailable devices are skipped: a device whose runtime was uninstalled must
# not pass validation only to fail at boot.
har_sim_device_field() {
  local devices
  devices="$(har_sim_simctl list devices --json)" || return 1
  printf '%s' "$devices" | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const [want, field] = process.argv.slice(1);
const device = Object.values(data.devices || {})
  .flat()
  .filter((entry) => entry && entry.isAvailable !== false)
  .find((entry) => entry.udid === want);
if (device && device[field]) process.stdout.write(String(device[field]));
' "$1" "$2" 2>/dev/null || true
}

har_sim_device_state() { har_sim_device_field "$1" state; }
har_sim_device_name() { har_sim_device_field "$1" name; }

# UDID of an existing device with this exact name, newest runtime first.
# A substring match would resolve "iPhone 16" to "iPhone 16 Pro Max".
har_sim_device_by_name() {
  local want="${1:-}" devices
  [ -n "$want" ] || return 0
  devices="$(har_sim_simctl list devices available --json)" || return 1
  printf '%s' "$devices" | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const want = process.argv[1];
const rows = [];
for (const [runtime, devices] of Object.entries(data.devices || {})) {
  if (!runtime.includes("SimRuntime.iOS-")) continue;
  const parts = runtime.match(/iOS-(\d+)(?:-(\d+))?/);
  const version = parts ? Number(parts[1]) * 1000 + Number(parts[2] || 0) : 0;
  for (const device of devices || []) {
    if (!device.udid || device.isAvailable === false) continue;
    if (device.name !== want) continue;
    rows.push({ udid: device.udid, version });
  }
}
rows.sort((a, b) => b.version - a.version);
if (rows[0]) process.stdout.write(rows[0].udid);
' "$want" 2>/dev/null || true
}

# The shared-mode device, as "<udid>\t<name>".
har_sim_resolve_configured() {
  local udid
  udid="$(har_sim_device_by_name "${HARNESS_SIMULATOR_NAME:-}")"
  [ -n "$udid" ] || return 0
  printf '%s\t%s' "$udid" "${HARNESS_SIMULATOR_NAME}"
}

# `simctl list` is a subprocess and a JSON parse, so each answer is cached — but in
# the calling shell, not the process: `$(har_sim_runtimes_json)` fetches, then throws
# the cache and the availability flag away with the subshell that held them. Call
# these directly and read the variable whenever either one matters.
har_sim_devicetypes_json() {
  if [ -z "${_HAR_SIM_TYPES_JSON:-}" ]; then
    _HAR_SIM_TYPES_JSON="$(har_sim_simctl list devicetypes --json)" || _HAR_SIM_TYPES_JSON='{}'
  fi
  printf '%s' "$_HAR_SIM_TYPES_JSON"
}

har_sim_runtimes_json() {
  if [ -z "${_HAR_SIM_RUNTIMES_JSON:-}" ]; then
    if _HAR_SIM_RUNTIMES_JSON="$(har_sim_simctl list runtimes --json)"; then
      _HAR_SIM_SIMCTL_OK=true
    else
      _HAR_SIM_RUNTIMES_JSON='{}'
      _HAR_SIM_SIMCTL_OK=false
      # A second call, but only ever when simctl is already failing — and failing
      # is the fast path. Its stderr is the only thing that tells the causes apart.
      _HAR_SIM_SIMCTL_ERROR="$(xcrun simctl list runtimes --json 2>&1 >/dev/null || true)"
    fi
  fi
  printf '%s' "$_HAR_SIM_RUNTIMES_JSON"
}

# Ask simctl once, recording in this shell whether it answered and why not.
har_sim_probe_simctl() {
  har_sim_runtimes_json >/dev/null
}

har_sim_simctl_available() {
  har_sim_probe_simctl
  [ "${_HAR_SIM_SIMCTL_OK:-true}" = "true" ]
}

# Two unrelated problems make simctl unusable — a sandbox denying the
# CoreSimulatorService lookup, and a developer directory with no simctl in it.
# Naming the wrong one costs the reader the hunt this check exists to prevent.
har_sim_log_simctl_unavailable() {
  # Teardown hits two failures in a row; the cause only needs saying once.
  [ -z "${_HAR_SIM_SIMCTL_CAUSE_REPORTED:-}" ] || return 0
  _HAR_SIM_SIMCTL_CAUSE_REPORTED=1
  # For a launch the failing call happened inside the command substitution around
  # har_sim_plan_creation, so the reason died with that subshell — ask again here.
  har_sim_probe_simctl
  case "${_HAR_SIM_SIMCTL_ERROR:-}" in
    *"not a developer tool"*|*"unable to find utility"*|*"command not found"*)
      har_sim_log "'xcrun simctl' is not in the selected developer directory"
      har_sim_log "  install Xcode, then point the toolchain at it:"
      har_sim_log "    sudo xcode-select -s /Applications/Xcode.app"
      har_sim_log "  current selection: $(xcode-select -p 2>/dev/null || echo 'none')"
      return
      ;;
  esac
  har_sim_log "cannot reach CoreSimulatorService — 'xcrun simctl' is unusable here"
  har_sim_log "  this usually means the command is running inside an agent sandbox"
  har_sim_log "  run it from a normal terminal, or let the agent run 'xcrun simctl' unsandboxed"
}

# Model and runtime to create this slot's device from. Failures carry the models
# this machine can create, so the caller never has to re-derive that list.
# Prints one of:
#   OK <deviceTypeId> <deviceTypeName> <runtimeId> <runtimeVersion>
#   NO_RUNTIME                        no iOS runtime installed
#   NO_MODEL <models>                 HARNESS_SIMULATOR_NAME is not a device model
#   NO_RUNTIME_FOR_MODEL <models>     model exists, no installed runtime supports it
#   SIMCTL_UNAVAILABLE                simctl could not be asked at all
har_sim_plan_creation() {
  local types runtimes
  types="$(har_sim_devicetypes_json)"
  # Not `$(...)`: that would discard the availability flag with the subshell.
  har_sim_runtimes_json >/dev/null
  runtimes="$_HAR_SIM_RUNTIMES_JSON"
  # Checked before the empty lists are read as an answer about the machine.
  if ! har_sim_simctl_available; then
    printf 'SIMCTL_UNAVAILABLE'
    return
  fi
  node -e '
const [typesRaw, runtimesRaw, wantName, family] = process.argv.slice(1);
const types = JSON.parse(typesRaw).devicetypes || [];
const version = (value) => {
  const [major = 0, minor = 0] = String(value || "0").split(".").map(Number);
  return major * 1000 + minor;
};
const runtimes = (JSON.parse(runtimesRaw).runtimes || [])
  .filter((runtime) => runtime.isAvailable !== false)
  .filter((runtime) => String(runtime.identifier || "").includes("SimRuntime.iOS-"))
  .sort((a, b) => version(b.version) - version(a.version));

const isPad = (entry) => /ipad/i.test(entry.productFamily || entry.name || "");
const inFamily = (entry) => (family === "iPad" ? isPad(entry) : !isPad(entry));

// Models the newest runtime could create, named so an error can list them.
// Truncation is stated rather than silent — a model cut off the list still exists.
function availableModels() {
  const runtime = runtimes[0];
  const supported =
    runtime && Array.isArray(runtime.supportedDeviceTypes) && runtime.supportedDeviceTypes.length
      ? runtime.supportedDeviceTypes
      : types;
  const names = supported.filter(inFamily).map((entry) => entry.name);
  const shown = names.slice(0, 8).join(", ");
  return names.length > 8 ? `${shown}, … (${names.length - 8} more)` : shown;
}

function plan() {
  if (!runtimes.length) return "NO_RUNTIME";
  if (wantName && !types.some((type) => type.name === wantName)) {
    return `NO_MODEL\t${availableModels()}`;
  }

  for (const runtime of runtimes) {
    const supported =
      Array.isArray(runtime.supportedDeviceTypes) && runtime.supportedDeviceTypes.length
        ? runtime.supportedDeviceTypes
        : types;
    // Apple lists supported device types newest first within each family.
    const pool = supported.filter(inFamily);
    const chosen = wantName ? pool.find((type) => type.name === wantName) : pool[0];
    if (chosen) {
      return `OK\t${chosen.identifier}\t${chosen.name}\t${runtime.identifier}\t${runtime.version}`;
    }
  }
  return wantName ? `NO_RUNTIME_FOR_MODEL\t${availableModels()}` : "NO_RUNTIME";
}

process.stdout.write(plan());
' "$types" "$runtimes" "${1:-}" "${2:-iPhone}" 2>/dev/null || true
}

# Every device whose name is <prefix> or starts with "<prefix>-", so a slot's
# leftovers are found whatever model they were created from.
har_sim_devices_with_prefix() {
  local devices
  devices="$(har_sim_simctl list devices --json)" || return 1
  printf '%s' "$devices" | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const prefix = process.argv[1];
const matches = Object.values(data.devices || {})
  .flat()
  .filter((device) => device && device.udid)
  .filter((device) => device.name === prefix || String(device.name || "").startsWith(`${prefix}-`))
  .map((device) => device.udid);
process.stdout.write(matches.join("\n"));
' "$1" 2>/dev/null || true
}

# Returns 0 even when it could not look: teardown.sh runs under `set -e`, and
# aborting there would leave the slot registry behind on top of the device.
har_sim_delete_devices_with_prefix() {
  local udid list
  if ! list="$(har_sim_devices_with_prefix "$1")"; then
    har_sim_log "cannot check for leftover devices named ${1}* — none were removed"
    har_sim_log_simctl_unavailable
    return 0
  fi
  while read -r udid; do
    [ -n "$udid" ] || continue
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  done <<< "$list"
}

# ── Boot ──────────────────────────────────────────────────────────────────────

har_sim_boot() {
  local udid="$1" i
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  if xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1; then
    return 0
  fi
  # Fallback for a toolchain without bootstatus: the plain listing is one
  # subprocess, where the JSON form costs xcrun plus node on every poll.
  for i in $(seq 1 30); do
    if xcrun simctl list devices 2>/dev/null | grep -q "${udid}.*Booted"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# ── Acquire / release ─────────────────────────────────────────────────────────

# Prints "<udid>\t<name>\t<createdByHar>".
_har_sim_select() {
  local agent_id="$1"
  local want="${HARNESS_SIMULATOR_NAME:-}"
  local family owner name plan status models device_type model runtime label udid

  # An explicit UDID is a deliberate override — never fall back off it.
  if [ -n "${HARNESS_SIMULATOR_UDID:-}" ]; then
    # A failed lookup is "could not ask"; an empty one is "no such device".
    name="$(har_sim_device_name "$HARNESS_SIMULATOR_UDID")" || {
      har_sim_log_simctl_unavailable
      return 1
    }
    if [ -z "$name" ]; then
      har_sim_log "HARNESS_SIMULATOR_UDID=${HARNESS_SIMULATOR_UDID} is not a known device"
      return 1
    fi
    owner="$(har_sim_claim_owner_of "$HARNESS_SIMULATOR_UDID" "$agent_id")"
    if [ -n "$owner" ]; then
      har_sim_log "warning: agent ${owner} already holds ${name} — a pinned HARNESS_SIMULATOR_UDID"
      har_sim_log "         gives every slot the same device; unset it to get one per slot."
    fi
    printf '%s\t%s\t%s' "$HARNESS_SIMULATOR_UDID" "$name" "false"
    return 0
  fi

  family="$(har_sim_preferred_family)"
  plan="$(har_sim_plan_creation "$want" "$family")"
  status="${plan%%$'\t'*}"
  # Failure statuses carry the creatable models after the first tab.
  models=""
  [ "$plan" != "$status" ] && models="${plan#*$'\t'}"

  if [ "$status" = "SIMCTL_UNAVAILABLE" ]; then
    har_sim_log_simctl_unavailable
    return 1
  fi

  if [ "$status" = "OK" ]; then
    IFS=$'\t' read -r _ device_type model runtime _ <<< "$plan"
    label="$(har_sim_device_label "$agent_id" "$model")"
    # A crashed launch can leave the slot's device behind — start from scratch,
    # including a device this slot created from a different model.
    har_sim_delete_devices_with_prefix "$(har_sim_device_label_prefix "$agent_id")"
    har_sim_log "creating ${label} (${model}, ${runtime##*SimRuntime.})"
    udid="$(xcrun simctl create "$label" "$device_type" "$runtime" 2>/dev/null | tr -d '[:space:]')"
    if [ -z "$udid" ]; then
      har_sim_log "xcrun simctl create failed for ${label} (${device_type}, ${runtime})"
      return 1
    fi
    printf '%s\t%s\t%s' "$udid" "$label" "true"
    return 0
  fi

  # Not a model: fall back to an existing device carrying that name, which is
  # how a hand-renamed simulator is targeted.
  if [ "$status" = "NO_MODEL" ]; then
    udid="$(har_sim_device_by_name "$want")"
    if [ -n "$udid" ]; then
      har_sim_log "'${want}' is not a device model — using the existing device with that name"
      printf '%s\t%s\t%s' "$udid" "$want" "false"
      return 0
    fi
    har_sim_log "HARNESS_SIMULATOR_NAME='${want}' is neither a device model nor an existing device"
    har_sim_log "  available ${family} models: ${models}"
    return 1
  fi

  if [ "$status" = "NO_RUNTIME_FOR_MODEL" ]; then
    har_sim_log "no installed iOS runtime supports '${want}'"
    har_sim_log "  install a newer runtime in Xcode → Settings → Components, or pick another model"
    har_sim_log "  available ${family} models: ${models}"
    return 1
  fi

  har_sim_log "no iOS simulator runtime is installed"
  har_sim_log "  install one in Xcode → Settings → Components"
  return 1
}

# Reserve a simulator for a slot, boot it, and record the claim.
# Prints "<udid>\t<name>" on success.
har_sim_acquire() {
  local agent_id="$1" udid name created
  local result="" rc=0
  # `|| rc=$?` keeps a failed selection from tripping `set -e` in the caller.
  result="$(_har_sim_select "$agent_id")" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"

  udid="$(printf '%s' "$result" | cut -f1)"
  name="$(printf '%s' "$result" | cut -f2)"
  created="$(printf '%s' "$result" | cut -f3)"
  if [ -z "$udid" ]; then
    har_sim_log "no simulator could be selected"
    return 1
  fi
  har_sim_write_claim "$agent_id" "$udid" "$name" "$created"

  if ! har_sim_boot "$udid"; then
    har_sim_log "device ${name} (${udid}) did not reach Booted state"
    return 1
  fi
  printf '%s\t%s' "$udid" "$name"
}

# Drop a slot's claim. Devices HAR created are deleted; a device the developer
# owns is left alone, and never even shut down.
har_sim_release() {
  local agent_id="$1" file udid created
  file="$(har_sim_claim_file "$agent_id")"
  if [ -f "$file" ]; then
    udid="$(read_slot_field "$file" udid || true)"
    created="$(read_slot_field "$file" createdByHar || true)"
    rm -f "$file"
    if [ "$created" = "true" ] && [ -n "$udid" ]; then
      xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
      if xcrun simctl delete "$udid" >/dev/null 2>&1; then
        echo "✓ Deleted simulator created for this slot ($udid)"
      else
        # Naming it is the whole remedy left: the claim is gone, so only the name
        # prefix sweep at the next launch can still find this device.
        har_sim_log "could not delete ${udid}, created for agent ${agent_id} — it is still on this machine"
        har_sim_simctl_available || har_sim_log_simctl_unavailable
      fi
    fi
  fi

  # A launch killed between `simctl create` and the claim leaves a device no
  # claim points at. Only HAR creates devices under this prefix, so sweeping it
  # can never remove one of the developer's.
  har_sim_delete_devices_with_prefix "$(har_sim_device_label_prefix "$agent_id")"
}

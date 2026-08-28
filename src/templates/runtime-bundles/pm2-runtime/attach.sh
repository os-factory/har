#!/usr/bin/env bash
# Attach to the tmux session for an agent.
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/attach.sh <agent-id>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Loop guard (#291): a pre-1.0 har does not own this runtime kind in the
# package — it executes this script as authoritative, which would exec back
# into har forever (one node process per cycle). Trip on re-entry for this
# harness root, and skip har binaries older than the pinned runtime (#298).
HAR_SHIM_GUARD="attach@${REPO_ROOT}"
case ":${HAR_SHIM_REENTRY:-}:" in *":${HAR_SHIM_GUARD}:"*)
  echo "Error: runtime loop detected — the har CLI that ran this shim delegated back into it." >&2
  echo "  The har runtime handling this repo is older than the harness contract (pinned: @osfactory/har@__HAR_VERSION__)." >&2
  echo "  Fix: npm i -g @osfactory/har@latest    # or in this repo: npm i -D @osfactory/har" >&2
  exit 86
  ;;
esac
export HAR_SHIM_REENTRY="${HAR_SHIM_REENTRY:-}:${HAR_SHIM_GUARD}"
# True when $1 reports a version >= the pinned runtime. Comparing only the
# major (#298) made the floor inert for the whole 0.x line: every pre-1.0 har
# passed it and then bounced straight back into this shim. Compare the full
# release triple, and treat anything unparseable as unusable.
har_runtime_compatible() {
  local v pinned="__HAR_VERSION__" i a b
  v="$("$1" --version 2>/dev/null | head -n1)" || return 1
  v="${v#v}"
  v="${v%%[-+ ]*}"
  local -a have pin
  IFS=. read -r -a have <<<"$v"
  IFS=. read -r -a pin <<<"${pinned%%[-+]*}"
  for i in 0 1 2; do
    a="${have[i]:-0}"
    b="${pin[i]:-0}"
    case "$a" in ''|*[!0-9]*) return 1 ;; esac
    case "$b" in ''|*[!0-9]*) return 1 ;; esac
    [ "$a" -gt "$b" ] && return 0
    [ "$a" -lt "$b" ] && return 1
  done
  return 0
}
# `$1` (not a named var) so `har env eject` can lift this delegate verbatim.
if command -v har >/dev/null 2>&1 && har_runtime_compatible har; then
  exec har env agent "${1:?Usage: attach.sh <agent-id>}" attach
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ] && har_runtime_compatible "$REPO_ROOT/node_modules/.bin/har"; then
  exec "$REPO_ROOT/node_modules/.bin/har" env agent "${1:?Usage: attach.sh <agent-id>}" attach
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes @osfactory/har@__HAR_VERSION__ env agent "${1:?Usage: attach.sh <agent-id>}" attach
fi
echo "Error: cannot run the HAR runtime — 'har' is not on PATH and Node.js (npx) is unavailable." >&2
echo "  Install Node.js, then: npm i -D @osfactory/har   # or: npx @osfactory/har@__HAR_VERSION__ env agent" >&2
exit 127

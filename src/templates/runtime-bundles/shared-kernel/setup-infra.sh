#!/usr/bin/env bash
# Set up shared infrastructure for all agent slots. Idempotent.
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/setup-infra.sh 
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Loop guard (#291): a pre-1.0 har does not own this runtime kind in the
# package — it executes this script as authoritative, which would exec back
# into har forever (one node process per cycle). Trip on re-entry for this
# harness root, and skip har binaries older than the pinned runtime's major.
HAR_SHIM_GUARD="setup-infra@${REPO_ROOT}"
case ":${HAR_SHIM_REENTRY:-}:" in *":${HAR_SHIM_GUARD}:"*)
  echo "Error: runtime loop detected — the har CLI that ran this shim delegated back into it." >&2
  echo "  The har runtime handling this repo is older than the harness contract (pinned: @osfactory/har@__HAR_VERSION__)." >&2
  echo "  Fix: npm i -g @osfactory/har@latest    # or in this repo: npm i -D @osfactory/har" >&2
  exit 86
  ;;
esac
export HAR_SHIM_REENTRY="${HAR_SHIM_REENTRY:-}:${HAR_SHIM_GUARD}"
har_runtime_compatible() {
  local v pinned="__HAR_VERSION__"
  v="$("$1" --version 2>/dev/null | head -n1)" || return 1
  [ "${v%%.*}" -ge "${pinned%%.*}" ] 2>/dev/null
}
if command -v har >/dev/null 2>&1 && har_runtime_compatible har; then
  exec har env setup-infra "$@"
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ] && har_runtime_compatible "$REPO_ROOT/node_modules/.bin/har"; then
  exec "$REPO_ROOT/node_modules/.bin/har" env setup-infra "$@"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes @osfactory/har@__HAR_VERSION__ env setup-infra "$@"
fi
echo "Error: cannot run the HAR runtime — 'har' is not on PATH and Node.js (npx) is unavailable." >&2
echo "  Install Node.js, then: npm i -D @osfactory/har   # or: npx @osfactory/har@__HAR_VERSION__ env setup-infra" >&2
exit 127

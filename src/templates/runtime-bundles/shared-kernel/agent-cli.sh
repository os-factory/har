#!/usr/bin/env bash
# Namespaced CLI for managing a running agent environment.
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/agent-cli.sh <agent-id> <command> [args...]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if command -v har >/dev/null 2>&1; then
  exec har env agent "$@"
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ]; then
  exec "$REPO_ROOT/node_modules/.bin/har" env agent "$@"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes @osfactory/har@__HAR_VERSION__ env agent "$@"
fi
echo "Error: cannot run the HAR runtime — 'har' is not on PATH and Node.js (npx) is unavailable." >&2
echo "  Install Node.js, then: npm i -D @osfactory/har   # or: npx @osfactory/har@__HAR_VERSION__ env agent" >&2
exit 127

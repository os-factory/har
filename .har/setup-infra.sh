#!/usr/bin/env bash
# Set up shared infrastructure for all agent slots. Idempotent.
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/setup-infra.sh 
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if command -v har >/dev/null 2>&1; then
  exec har env setup-infra "$@"
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ]; then
  exec "$REPO_ROOT/node_modules/.bin/har" env setup-infra "$@"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes @osfactory/har@0.64.1 env setup-infra "$@"
fi
echo "Error: cannot run the HAR runtime — 'har' is not on PATH and Node.js (npx) is unavailable." >&2
echo "  Install Node.js, then: npm i -D @osfactory/har   # or: npx @osfactory/har@0.64.1 env setup-infra" >&2
exit 127

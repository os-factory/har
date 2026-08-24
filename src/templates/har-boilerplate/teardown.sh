#!/usr/bin/env bash
# Tear down one agent slot: stop processes, release resources, keep the session branch.
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/teardown.sh <agent-id> [--delete-branch]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if command -v har >/dev/null 2>&1; then
  exec har env teardown "$@"
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ]; then
  exec "$REPO_ROOT/node_modules/.bin/har" env teardown "$@"
fi
echo "Error: the 'har' CLI is not available. Install @osfactory/har (npm i -D @osfactory/har) or run: npx @osfactory/har env teardown" >&2
exit 127

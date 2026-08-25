#!/usr/bin/env bash
# Launch an isolated agent environment slot (fresh suffixed worktree; occupied slots block).
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/launch.sh <agent-id> [--no-worktree] [--resume]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if command -v har >/dev/null 2>&1; then
  exec har env launch "$@"
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ]; then
  exec "$REPO_ROOT/node_modules/.bin/har" env launch "$@"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes @osfactory/har@0.64.1 env launch "$@"
fi
echo "Error: cannot run the HAR runtime — 'har' is not on PATH and Node.js (npx) is unavailable." >&2
echo "  Install Node.js, then: npm i -D @osfactory/har   # or: npx @osfactory/har@0.64.1 env launch" >&2
exit 127

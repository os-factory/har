#!/usr/bin/env bash
# Verification pipeline (stages.json verificationStages; quick by default, --full for the whole list). JSON to stdout.
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/verify.sh <agent-id> [--full]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if command -v har >/dev/null 2>&1; then
  exec har env verify "$@" --json
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ]; then
  exec "$REPO_ROOT/node_modules/.bin/har" env verify "$@" --json
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes @osfactory/har@__HAR_VERSION__ env verify "$@" --json
fi
echo "Error: cannot run the HAR runtime — 'har' is not on PATH and Node.js (npx) is unavailable." >&2
echo "  Install Node.js, then: npm i -D @osfactory/har   # or: npx @osfactory/har@__HAR_VERSION__ env verify" >&2
exit 127

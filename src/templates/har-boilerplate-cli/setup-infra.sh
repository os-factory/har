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
fi
echo "Error: the 'har' CLI is not available. Install @osfactory/har (npm i -D @osfactory/har) or run: npx @osfactory/har env setup-infra" >&2
exit 127

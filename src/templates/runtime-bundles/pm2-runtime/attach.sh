#!/usr/bin/env bash
# Attach to the tmux session for an agent.
# The runtime lives in the HAR package (#234) — this file only forwards to it.
# Usage: ./.har/attach.sh <agent-id>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_ID="${1:?Usage: attach.sh <agent-id>}"
if command -v har >/dev/null 2>&1; then
  exec har env agent "$AGENT_ID" attach
elif [ -x "$REPO_ROOT/node_modules/.bin/har" ]; then
  exec "$REPO_ROOT/node_modules/.bin/har" env agent "$AGENT_ID" attach
fi
echo "Error: the 'har' CLI is not available. Install @osfactory/har (npm i -D @osfactory/har) or run: npx @osfactory/har env agent" >&2
exit 127

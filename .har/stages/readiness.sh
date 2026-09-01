#!/usr/bin/env bash
# Project readiness smoke: runs HARNESS_READINESS_CMD from harness.env, an
# optional project-owned "agent usable" check beyond health. Registered as the
# `readiness` verification stage (tier: full).
set -euo pipefail

AGENT_ID="${1:?Usage: readiness.sh <agent-id>}"

if [ -z "${HARNESS_READINESS_CMD:-}" ]; then
  echo "No HARNESS_READINESS_CMD configured; skipping readiness smoke."
  exit 0
fi

eval "${HARNESS_READINESS_CMD//\{agentId\}/$AGENT_ID}"

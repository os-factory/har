#!/usr/bin/env bash
# API health check for the slot's primary application. Registered as the
# `api-health` verification stage (tier: quick) on web profiles.
set -euo pipefail

AGENT_ID="${1:?Usage: api-health.sh <agent-id>}"

PORT="${API_PORT:-$(( ${HARNESS_API_BASE_PORT:?HARNESS_API_BASE_PORT not set} + AGENT_ID * 10 ))}"
exec curl -sf "http://localhost:${PORT}${HARNESS_HEALTH_CHECK_PATH:-/health}"

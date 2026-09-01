#!/usr/bin/env bash
# flows/example-smoke.sh — Smoke test: verify the app launches and shows its main screen.
#
# Adapt this flow for your application:
#   1. Replace "Main Screen Title" with a visible element on your app's main screen.
#   2. Optionally add a tap and validate the next screen.
#   3. Rename and copy to create more specific user journey flows.
#
# See .har/stages/ROCKETSIM.md for the full authoring guide.
set -euo pipefail

log() { echo "==> [example-smoke] $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────────
# The app must be running on THIS slot's simulator. Install and launch it before
# running this flow — target the reserved device, not `booted`. Example:
#   xcrun simctl install "${HARNESS_SIMULATOR_UDID:-booted}" path/to/MyApp.app
#   xcrun simctl launch "${HARNESS_SIMULATOR_UDID:-booted}" "${HARNESS_BUNDLE_ID}"

log "Checking simulator focus..."
FOCUSED=$(rocketsim simulator focused 2>/dev/null || echo "")
if [ -z "$FOCUSED" ]; then
  log "✗ No focused simulator — run har env setup-infra first"
  exit 1
fi
log "Simulator: $(echo "$FOCUSED" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.name||d.trim());}catch{process.stdout.write(d.trim());}})" 2>/dev/null || echo "$FOCUSED")"

# ── Wait for app to be ready ──────────────────────────────────────────────────
log "Waiting for app to settle..."
rocketsim wait screen-changed --timeout 5 2>/dev/null || true
sleep 1

# ── Read visible elements ─────────────────────────────────────────────────────
ELEMENTS=$(rocketsim elements --agent 2>/dev/null || echo "")

if [ -z "$ELEMENTS" ]; then
  log "✗ No elements found on screen — is the app running?"
  rocketsim screenshot > "$FLOW_ARTIFACT_DIR/failure-no-elements.png" 2>/dev/null || true
  exit 1
fi

log "Visible elements:"
echo "$ELEMENTS" | head -20 | sed 's/^/    /' >&2

# ── Assert main screen ────────────────────────────────────────────────────────
# TODO: replace "Main Screen Title" with a StaticText or other element that
# uniquely identifies your app's main screen after launch.
EXPECTED_LABEL="Main Screen Title"

if echo "$ELEMENTS" | grep -qi "$EXPECTED_LABEL"; then
  log "✓ Found expected element: '$EXPECTED_LABEL'"
  rocketsim screenshot > "$FLOW_ARTIFACT_DIR/success.png" 2>/dev/null || true
else
  log "✗ Expected element not found: '$EXPECTED_LABEL'"
  log "  Adapt EXPECTED_LABEL in flows/example-smoke.sh to match your app's main screen."
  rocketsim screenshot > "$FLOW_ARTIFACT_DIR/failure-missing-element.png" 2>/dev/null || true
  exit 1
fi

log "Smoke test passed."

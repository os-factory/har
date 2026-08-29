# RocketSim User-Flow Validation

The `rocketsim-flows` stage runs reusable bash scripts from `flows/` that interact with your iOS app on the simulator and validate its state. Full verify (`verify --full`) runs all flows automatically.

## Flow script contract

A flow is a bash script (`flows/<name>.sh`) that:

1. Uses the `rocketsim` CLI to inspect the UI, interact with the app, and take screenshots
2. Exits **0** on success (all assertions passed), **non-zero** on failure
3. Writes human-readable progress to **stderr**
4. Optionally saves screenshots to `$FLOW_ARTIFACT_DIR` (provided by the runner)

The runner sets these environment variables for each flow:
| Variable | Value |
|----------|-------|
| `FLOW_ARTIFACT_DIR` | Directory for screenshots and output of this flow |
| `WORK_DIR` | Path to the agent's session worktree |
| `HARNESS_BUNDLE_ID` | App bundle identifier (from `harness.env`) |
| `HARNESS_SIMULATOR_NAME` | Simulator model configured in `harness.env` |
| `HARNESS_SIMULATOR_DEVICE_NAME` | Name of the device created for this slot |
| `HARNESS_SIMULATOR_UDID` | UDID of that device — target it rather than `booted` |
| `AGENT_ID` | Active agent slot id |

## Key RocketSim CLI commands

```bash
# Health check
rocketsim doctor

# Check which simulator is focused
rocketsim simulator focused

# Read visible UI elements (compact format for agents)
rocketsim elements --agent

# Wait for screen to change after an interaction
rocketsim wait screen-changed

# Wait for a specific element to appear
rocketsim wait element --label "Continue"

# Tap by element label
rocketsim interact tap --label "Continue"

# Tap by type + label (more precise)
rocketsim interact tap --type Button --label "Submit"

# Tap at coordinates
rocketsim interact tap 210 642

# Swipe
rocketsim interact swipe --direction up
rocketsim interact swipe --from 200,650 --to 200,150

# Type text
rocketsim interact type "hello@example.com"

# Press hardware button
rocketsim interact button home

# Take a screenshot (PNG bytes to stdout)
rocketsim screenshot > "$FLOW_ARTIFACT_DIR/screen.png"
```

## Writing a new flow

```bash
#!/usr/bin/env bash
# flows/my-feature.sh — Validate MyFeature after changes
set -euo pipefail

log() { echo "==> [my-feature] $*" >&2; }

# 1. Snapshot the current screen
rocketsim wait screen-changed --timeout 5 2>/dev/null || true
ELEMENTS=$(rocketsim elements --agent)

# 2. Assert expected element is present
if echo "$ELEMENTS" | grep -q "My Feature Button"; then
  log "✓ My Feature Button visible"
else
  log "✗ My Feature Button not found"
  rocketsim screenshot > "$FLOW_ARTIFACT_DIR/failure.png"
  exit 1
fi

# 3. Interact
rocketsim interact tap --label "My Feature Button"
rocketsim wait screen-changed

# 4. Assert outcome
AFTER=$(rocketsim elements --agent)
if echo "$AFTER" | grep -q "Expected Result Label"; then
  log "✓ Expected result is visible"
  rocketsim screenshot > "$FLOW_ARTIFACT_DIR/success.png"
else
  log "✗ Expected result not visible"
  rocketsim screenshot > "$FLOW_ARTIFACT_DIR/failure.png"
  exit 1
fi
```

## Running flows

```bash
# All flows
./.har/stages/rocketsim-flows.sh 1

# Single flow
./.har/stages/rocketsim-flows.sh 1 example-smoke

# Included in full verify
har env verify 1 --full
```

Screenshots and per-flow logs are saved under `.har/artifacts/rocketsim-flows/`.

## Guidelines for agents creating flows

- **One flow per user journey** — keep flows focused: login, onboarding, settings, a specific feature.
- **Validate after each action** — use `rocketsim wait screen-changed` or `wait element` before asserting.
- **Take a screenshot on failure** — always save `$FLOW_ARTIFACT_DIR/failure.png` on assertion failures so humans can diagnose problems.
- **Take a screenshot on success** — save `$FLOW_ARTIFACT_DIR/success.png` as visual confirmation.
- **Use label-based selectors** — prefer `--label` over raw coordinates; coordinates break when layout changes.
- **Reset state** — if the flow navigates away from the start screen, navigate back at the end.
- **Name flows for their user journey** — `onboarding.sh`, `login.sh`, `settings-notification-toggle.sh`.
- **Add a new flow for every new UI feature** — this ensures regressions are caught on future changes.

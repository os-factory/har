# User Flow Scripts (RocketSim)

This directory contains reusable bash scripts that validate your iOS app's user flows against a running simulator using the [RocketSim CLI](https://www.rocketsim.app/docs/features/agentic-development/rocketsim-cli/).

The `rocketsim-flows` harness stage runs all scripts in this directory during full verification (`verify --full`). A single flow can also be run directly:

```bash
./.har/stages/rocketsim-flows.sh 1 <flow-name>
```

## Adding a new flow

1. Create `flows/<name>.sh` (copy from `example-smoke.sh`)
2. Make it executable: `chmod +x flows/<name>.sh`
3. Run it: `./.har/stages/rocketsim-flows.sh 1 <name>`

Read `.har/stages/ROCKETSIM.md` for the full authoring guide and CLI reference.

## Naming convention

| Pattern | Example |
|---------|---------|
| One flow per user journey | `onboarding.sh`, `login.sh`, `checkout.sh` |
| Feature-specific flows | `settings-notifications.sh`, `profile-edit.sh` |
| Smoke test (run first) | `example-smoke.sh` or `smoke.sh` |

## How flows are run

The runner (`rocketsim-flows.sh`) sets these variables for every flow:

| Variable | Description |
|----------|-------------|
| `FLOW_ARTIFACT_DIR` | Save screenshots here (`$FLOW_ARTIFACT_DIR/success.png`, `failure.png`) |
| `HARNESS_BUNDLE_ID` | App bundle ID from `harness.env` |
| `HARNESS_SIMULATOR_NAME` | Simulator model configured in `harness.env` |
| `HARNESS_SIMULATOR_DEVICE_NAME` | Name of the device created for this slot |
| `HARNESS_SIMULATOR_UDID` | UDID of that device — target it instead of `booted`, which may be another slot's |
| `WORK_DIR` | Path to the session worktree |

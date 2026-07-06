# RocketSim Stage Template

Add reusable RocketSim user-flow validation to your iOS harness.

```bash
har env add-stage rocketsim
```

## What this installs

| File | Purpose |
|------|---------|
| `.har/stages/rocketsim-flows.sh` | Stage runner — discovers and runs all `flows/*.sh` scripts |
| `.har/stages/ROCKETSIM.md` | Authoring guide: CLI reference, flow contract, naming conventions |
| `flows/README.md` | Quick start for adding new flows |
| `flows/example-smoke.sh` | Example smoke test — adapt for your app's main screen |

## Workflow

```
        Code change
             │
       launch slot
             │
    build + unit-tests
             │
      rocketsim-flows  ◄── your flows/*.sh scripts
             │
          pass/fail
```

Full verify (`verify --full`) runs all flows after lint.

## Requirements

- [RocketSim](https://www.rocketsim.app/) installed and running
- `rocketsim` CLI installed from RocketSim → Settings → CLI & Agent
- At least one iOS Simulator booted (`xcrun simctl list devices | grep Booted`)
- Your app installed on the simulator before running flows

## Quick start after install

```bash
# 1. Install the stage
har env add-stage rocketsim

# 2. Check RocketSim health
rocketsim doctor

# 3. Build and install your app
xcodebuild build ... && xcrun simctl install booted path/to/MyApp.app
xcrun simctl launch booted com.example.myapp

# 4. Run the example flow (adapt it for your main screen)
./.har/stages/rocketsim-flows.sh 1 example-smoke

# 5. Add real flows
cp flows/example-smoke.sh flows/my-feature.sh
# Edit flows/my-feature.sh to navigate your app and assert state

# 6. Run all flows
./.har/stages/rocketsim-flows.sh 1

# 7. Validate everything
./.har/verify.sh 1 --full
```

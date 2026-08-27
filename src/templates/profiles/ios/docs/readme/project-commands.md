## Project commands

Target **this slot's** simulator, never `booted` — another agent's device may also
be booted. `HARNESS_IOS_DESTINATION` and `HARNESS_SIMULATOR_UDID` come from
`.env.agent.<id>`.

```bash
source .env.agent.<id>

# Build
xcodebuild build -scheme MyApp -destination "$HARNESS_IOS_DESTINATION" CODE_SIGNING_ALLOWED=NO

# Run unit tests — signed, or an app with entitlements traps at launch
xcodebuild test -scheme MyApp -destination "$HARNESS_IOS_DESTINATION"

# Install and launch on this slot's device
har env agent <id> install path/to/MyApp.app
har env agent <id> launch-app
```

Adapt for your scheme — see `.har/harness.env`.

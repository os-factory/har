## Project commands

Target **this slot's** simulator, never `booted` — another agent's device may also
be booted. `HARNESS_IOS_DESTINATION` and `HARNESS_SIMULATOR_UDID` come from
`.env.agent.${AGENT_ID}`.

```bash
source .env.agent.${AGENT_ID}

# Build
xcodebuild build -scheme MyApp -destination "$HARNESS_IOS_DESTINATION" CODE_SIGNING_ALLOWED=NO

# Run unit tests — signed, or an app with entitlements traps at launch
xcodebuild test -scheme MyApp -destination "$HARNESS_IOS_DESTINATION"

# Install and launch on this slot's device
./.har/agent-cli.sh ${AGENT_ID} install path/to/MyApp.app
./.har/agent-cli.sh ${AGENT_ID} launch-app
```

Adapt for your scheme — see `.har/harness.env`.

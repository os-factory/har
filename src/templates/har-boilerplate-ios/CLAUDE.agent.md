# Agent ${AGENT_ID} — iOS Development Environment

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |
| **Simulator** | Configured in `.har/harness.env` — `HARNESS_SIMULATOR_NAME` |
| **Scheme** | Configured in `.har/harness.env` — `HARNESS_XCODE_SCHEME` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Relaunching replaces the session (branch kept) and requires explicit confirmation; dirty worktrees also need `--force` after user approval.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
```

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] When `stages/rocketsim-flows.sh` exists, full verify includes user-flow validation — add or update flow scripts in `flows/` for UI changes
- [ ] New behavior has automated test coverage (unit tests via XCTest)
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] Finish with `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — records the validation and tears down while **keeping the session branch** for the user to push / open a PR

Quick loop: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}`

## Project commands

```bash
# Build
xcodebuild build -scheme MyApp -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO

# Run unit tests
xcodebuild test -scheme MyApp -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO

# Install app on booted simulator
xcrun simctl install booted path/to/MyApp.app

# Launch app
xcrun simctl launch booted com.example.myapp
```

Adapt for your scheme and simulator — see `.har/harness.env`.

## User-flow validation (RocketSim)

If the RocketSim stage template is installed (`har env add-stage rocketsim`):

```bash
./.har/stages/rocketsim-flows.sh ${AGENT_ID}
# included in:
./.har/verify.sh ${AGENT_ID} --full
```

Add and edit user flow scripts in `flows/`. Read `.har/stages/ROCKETSIM.md` for the full authoring guide.

## Do not

- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.${AGENT_ID}` by hand
- Run verify before launch (the simulator and worktree must be set up first)
- Edit the main checkout — all edits go under the session work dir

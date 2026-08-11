# Agent ${AGENT_ID} — iOS Development Environment

> [`AGENTS.md`](../AGENTS.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |
| **Simulator** | Created for this slot at launch — `HARNESS_SIMULATOR_UDID` in `.env.agent.${AGENT_ID}` |
| **Scheme** | Configured in `.har/harness.env` — `HARNESS_XCODE_SCHEME` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
```

## Readiness

Adapt this section for the repository. A successful build/test run does not
always mean an agent can use the app. If the app needs a backend, credentials,
seeded data, or a simulator flow, document it here and wire the smoke into
`HARNESS_READINESS_CMD`, RocketSim flows, or full verify.

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] The slot is agent-usable for this repo's documented smoke workflow when runtime services are involved
- [ ] When `stages/rocketsim-flows.sh` exists, full verify includes user-flow validation — add or update flow scripts in `flows/` for UI changes
- [ ] New behavior has automated test coverage (unit tests via XCTest)
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] Present session handoff (summary, branch, preview URLs) and **wait for user** before `complete`, push, or PR
- [ ] On user approval of the default: push + open PR (when `gh`/GitHub MCP available), then `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — full verify + validation + teardown, branch kept

### Session handoff

After full verify and commit, stop and propose next steps. Never autonomously run
`complete`, `teardown`, `git push`, or open a PR. **Default recommendation:** when
`gh` or GitHub MCP is available, complete the slot **and** open a PR (push → PR →
`har env complete` / `har_complete_environment`). Offer complete-only or something
else as alternatives. If PR tooling is unavailable, recommend complete and report
the session branch for a manual push. Prefer `complete` over bare `teardown` when
the work succeeded. See `.cursor/rules/har-workflow.mdc` for the handoff shape.

Quick loop: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}`

Stages are the harness's single vocabulary for checks: templates and custom stages compile to generic kinds in `.har/stages.json`, and you interact with them only through the registry (`har_run_stage`, `verify`), never stack-specific tooling. Authoring guide: `.har/STAGES.md`.

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

## User-flow validation (RocketSim)

If the RocketSim plugin is installed (`har env add-plugin rocketsim`):

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

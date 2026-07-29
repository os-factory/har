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

## Readiness

Adapt this section for the repository. A successful build/test run does not
always mean an agent can use the app. If the app needs a backend, credentials,
seeded data, or a simulator flow, document it here and wire the smoke into
`HARNESS_READINESS_CMD`, RocketSim flows, or full verify.

## Definition of done

HAR exists so agents **prove a change works before opening a PR** — not only that the
app builds. Quick verify is **smoke only**. Smoke alone is **never** done.

- [ ] **Change-specific oracle:** at least one verification stage exercises the *behavior
  this change is supposed to fix/add* (user flow / focused check) — not build-only
- [ ] **Fail-before / pass-after:** that oracle **fails** before the fix and **passes** after.
  If a new stage already passes on the broken behavior, rewrite it
- [ ] **Functional proof:** `har env verify ${AGENT_ID} --full` returns `"status": "pass"`
  (runs `verificationStages` — e.g. RocketSim flows when installed)
- [ ] If no stage confirms the change is functional, add one
  (`har env add-stage … --custom --verification` or `rocketsim`) then re-run `--full`
- [ ] The slot is agent-usable for this repo's documented smoke workflow when runtime services are involved
- [ ] When `stages/rocketsim-flows.sh` exists, full verify includes user-flow validation — add or update flow scripts in `flows/` for UI changes
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] Finish with `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — records the validation and tears down while **keeping the session branch** for the user to push / open a PR

Quick loop while iterating: `har env verify ${AGENT_ID}` (smoke). Before you stop: `--full` with a real behavioral stage green.

Stages are the harness's single vocabulary for checks: templates and custom stages compile to generic kinds in `.har/stages.json`, and you interact with them only through the registry (`har_run_stage`, `verify`), never stack-specific tooling. Authoring guide: `.har/STAGES.md`.

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

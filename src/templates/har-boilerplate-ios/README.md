# .har — Agent Harness (iOS mobile app profile)

This directory is the **agent harness** for this iOS mobile app repository. It lets AI coding agents build, test, and validate the app in isolated git worktrees against a running iOS Simulator.

Generated and maintained by [`har`](https://github.com/os-factory/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Launch a slot to exercise the code in isolation; don't hand-roll Xcode/simulator setup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, profile, checksums) — do not edit |
| `harness.env` | Shared config: Xcode scheme, simulator name, bundle ID, toolchain provisioning, infra flags |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP — gitignored |
| `artifacts/` | Stage outputs: test results, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation and slot registry helpers |
| `setup-infra.sh` | Check the toolchain; start optional Docker services |
| `simulator.sh` | Create, boot and delete one iOS Simulator per agent slot |
| `launch.sh` | Launch one agent slot (git worktree, toolchain provisioning, simulator, env file) |
| `provision-toolchain.sh` | Generate the Xcode project when it is a build product (Tuist / XcodeGen / CocoaPods) and write Xcode paths (`XCODEBUILD_BIN`, …) to `.env.agent.<id>` |
| `verify.sh` | Verification pipeline (build smoke by default; --full adds tests, lint, flows) |
| `teardown.sh` | Tear down one agent slot (worktree + env file) |
| `agent-cli.sh` | Inspect slot status, run xcodebuild commands, install/launch app |
| `docker-compose.agent.yml` | Optional shared backend services |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

No PM2 or web-port wiring in this profile — agents run xcodebuild commands directly in their worktree.

## Quick start

**Preferred — har CLI or MCP** (persists run history under `.har/runs/`):

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment`.

**Shell fallback** (no CLI/MCP installed):

```bash
./.har/setup-infra.sh          # boots the iOS Simulator
./.har/launch.sh 1
./.har/verify.sh 1             # quick: build smoke (compile-only)
./.har/verify.sh 1 --full      # + unit tests, lint, rocketsim-flows (if installed)
./.har/teardown.sh 1
```

## User-flow validation

Add the RocketSim plugin to get reusable UI flow validation:

```bash
har env add-plugin rocketsim
```

This installs `.har/stages/rocketsim-flows.sh` and a `flows/` directory. Add flow scripts under `flows/` (see `.har/stages/ROCKETSIM.md`). Full verify automatically runs all flows.

## Verification contract

Steps in `verify.sh` are **project-specific examples** — adapt them to your stack.
The table describes each tier's intent, not a fixed command list.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` | build smoke (compile-only) |
| Full | `har env verify <id> --full` | + unit tests, lint, optional readiness smoke, **rocketsim-flows** when installed |

For apps that depend on local backends, auth, seeded state, or simulator flows,
distinguish build/test health from agent usability. Document any skipped full
dev setup and add a readiness command when agents need a real workflow to pass.

## Configuration

Edit **`harness.env`** to set:
- `HARNESS_XCODE_SCHEME` — your app's shared Xcode scheme
- `HARNESS_XCODE_WORKSPACE` or `HARNESS_XCODE_PROJECT` — path to the project file
- `HARNESS_SIMULATOR_NAME` — preferred simulator, matched by exact name
- `HARNESS_BUNDLE_ID` — app bundle identifier

## Simulators

Slots do not share a simulator. Each launch **creates**
`har-<project>-agent-<id>-<model>` — `har-storefront-agent-2-iPhone-17`, say — and
teardown deletes it, so two agents never collide on a destination, on an installed
bundle id, or on a UI session, and the simulators you use by hand are never touched.
Every launch also starts from a pristine device: no app installed, no leftover
store, nothing carried over from the previous session.

| Setting | Effect |
|---------|--------|
| `HARNESS_SIMULATOR_NAME` | The model to create — `iPhone 16`, `iPhone 17 Pro`, `iPad Air 11-inch (M2)`. Empty means the newest model of the family. See `xcrun simctl list devicetypes`. |
| `HARNESS_SIMULATOR_FAMILY` | `auto` (read from the name) \| `iPhone` \| `iPad`. An iPad is only created when this resolves to iPad. |
| `HARNESS_SIMULATOR_UDID` | Run every slot on one existing device instead. Slots then share it — for one-off debugging. |
| `HARNESS_SIMULATOR_SHARED` | `true` restores one shared simulator for all slots, booted by `setup-infra.sh`. |

The runtime is the newest installed iOS that supports the model — a model retired
from recent runtimes still resolves against an older one. When nothing matches,
launch fails and lists the models this machine can create.

If `HARNESS_SIMULATOR_NAME` is not a model but names an existing device, that
device is used as-is and never deleted — how a hand-renamed simulator is targeted.

### Running from an agent sandbox

`xcrun simctl` reaches CoreSimulatorService over XPC. Coding agents that sandbox
their shell (Codex, Claude Code and others) usually deny that lookup, so `simctl`
fails while `xcodebuild` keeps working — every simulator command then dies with
`CoreSimulatorService connection became invalid`. Nothing is missing on the machine.

Launch and teardown say so when it happens. Either run `har env launch <id>` and
`har env teardown <id>` from a normal terminal and let the agent work in the
worktree, or grant the agent unsandboxed access to `xcrun simctl` — the escalation
must cover every subcommand the harness uses (`list`, `create`, `boot`,
`bootstatus`, `shutdown`, `delete`), not just `list`.

The same messages distinguish a second cause: if `xcrun simctl` is missing from
the selected developer directory — no Xcode, or `xcode-select` pointing at the
Command Line Tools — they say so and print the current selection instead of
blaming a sandbox.

The device lands in `.env.agent.<id>` as `HARNESS_SIMULATOR_UDID`,
`HARNESS_SIMULATOR_DEVICE_NAME` and `HARNESS_IOS_DESTINATION` — the model stays in
`HARNESS_SIMULATOR_NAME`, so the two never mean the same thing in one place; what a slot holds is tracked in `.har/simulators/`.
Use `./.har/agent-cli.sh <id> simulator` to see it.

## Port & shared services (iOS profile)

Pure iOS apps have **no per-slot TCP ports** — agents build and run on a shared iOS Simulator. Optional backend containers (mock API, etc.) use the same shared-infra model as other profiles.

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Optional backend (compose) | Per machine | `HARNESS_*_PORT_DEFAULT` for that service | Scan configured ranges in `harness.env` |
| iOS Simulator | Per slot | One device created per agent — no harness port | None: `har-<project>-agent-<id>-<model>` is unique per slot |

When your app talks to a local backend, read the resolved host port from `.env.agent.<id>` (set by `setup-infra.sh`) — never hardcode `15432` or similar in tests or flow scripts.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| iOS Simulator | One device created per slot, deleted at teardown | `HARNESS_SIMULATOR_*`, `launch.sh` |
| Optional backend | One shared compose service | `HARNESS_INFRA_SERVICES` (e.g. `"mock-server"`) |
| Application code | Isolated git worktree per slot | `HARNESS_USE_WORKTREE=true` |

### Do not

- Hardcode backend ports in RocketSim flows or unit tests — read from agent env
- Run raw `docker compose` for harness infrastructure — use `setup-infra.sh`

## Session lifecycle

Every `launch` starts a **fresh session**: a new git worktree from the **main
checkout's current HEAD** at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
Switch that checkout to your intended base before launch. The session is recorded in
`.har/slots/agent-<id>.json`.

- Occupied slots always block a new launch: `har env complete <id>` (or `teardown <id>`),
  then `har env launch <id>`. A new launch never chooses `main` for you — switch the
  main checkout to your intended base first.
- `teardown` removes the worktree but **keeps the session branch** for push / PR.
- `har env complete <id>` finishes a session: full verify + teardown, branch kept.

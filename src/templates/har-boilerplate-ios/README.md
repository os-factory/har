# .har — Agent Harness (iOS mobile app profile)

This directory is the **agent harness** for this iOS mobile app repository. It lets AI coding agents build, test, and validate the app in isolated git worktrees against a running iOS Simulator.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

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
| `setup-infra.sh` | Boot the iOS Simulator; start optional Docker services |
| `launch.sh` | Launch one agent slot (git worktree, toolchain provisioning, env file) |
| `provision-toolchain.sh` | Write Xcode/simulator paths (`XCODEBUILD_BIN`, …) to `.env.agent.<id>` |
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
- `HARNESS_SIMULATOR_NAME` — target simulator (must be listed in `xcrun simctl list devices`)
- `HARNESS_BUNDLE_ID` — app bundle identifier

## Port & shared services (iOS profile)

Pure iOS apps have **no per-slot TCP ports** — agents build and run on a shared iOS Simulator. Optional backend containers (mock API, etc.) use the same shared-infra model as other profiles.

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Optional backend (compose) | Per machine | `HARNESS_*_PORT_DEFAULT` for that service | Scan configured ranges in `harness.env` |
| iOS Simulator | Shared | No harness port — one booted simulator for all slots | N/A |

When your app talks to a local backend, read the resolved host port from `.env.agent.<id>` (set by `setup-infra.sh`) — never hardcode `15432` or similar in tests or flow scripts.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| iOS Simulator | One booted simulator shared by all slots | `HARNESS_SIMULATOR_NAME`, `setup-infra.sh` |
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

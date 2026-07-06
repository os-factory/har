# .har — Agent Harness (iOS mobile app profile)

This directory is the **agent harness** for this iOS mobile app repository. It lets AI coding agents build, test, and validate the app in isolated git worktrees against a running iOS Simulator.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Launch a slot to exercise the code in isolation; don't hand-roll Xcode/simulator setup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, profile, checksums) — do not edit |
| `harness.env` | Shared config: Xcode scheme, simulator name, bundle ID, infra flags |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP — gitignored |
| `artifacts/` | Stage outputs: test results, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation and slot registry helpers |
| `setup-infra.sh` | Boot the iOS Simulator; start optional Docker services |
| `launch.sh` | Launch one agent slot (git worktree, CocoaPods/SPM deps, env file) |
| `verify.sh` | Verification pipeline (build + unit-tests; --full adds lint + user-flow validation) |
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
./.har/verify.sh 1             # build + unit-tests
./.har/verify.sh 1 --full      # + lint + rocketsim-flows (if installed)
./.har/teardown.sh 1
```

## User-flow validation

Add the RocketSim stage template to get reusable UI flow validation:

```bash
har env add-stage rocketsim
```

This installs `.har/stages/rocketsim-flows.sh` and a `flows/` directory. Add flow scripts under `flows/` (see `.har/stages/ROCKETSIM.md`). Full verify automatically runs all flows.

## Verification contract

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` | build, unit-tests |
| Full | `har env verify <id> --full` | + lint, **rocketsim-flows** when installed |

## Configuration

Edit **`harness.env`** to set:
- `HARNESS_XCODE_SCHEME` — your app's shared Xcode scheme
- `HARNESS_XCODE_WORKSPACE` or `HARNESS_XCODE_PROJECT` — path to the project file
- `HARNESS_SIMULATOR_NAME` — target simulator (must be listed in `xcrun simctl list devices`)
- `HARNESS_BUNDLE_ID` — app bundle identifier

## Session lifecycle

Every `launch` starts a **fresh session**: a new git worktree from the current HEAD at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
The session is recorded in `.har/slots/agent-<id>.json`.

- Relaunching a slot **replaces** its previous session; uncommitted changes require `--force`.
- `teardown` removes the worktree but **keeps the session branch** for push / PR.
- `har env complete <id>` finishes a session: full verify + teardown, branch kept.

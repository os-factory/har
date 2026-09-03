---
title: Environment variables
description: Important harness configuration and per-slot runtime values.
---

Edit shared configuration in `.har/harness.env`. Launch expands resolved values into
`.env.agent.<id>`; do not edit generated slot files manually.

## Project and slots

| Variable | Meaning |
| --- | --- |
| `HARNESS_PROJECT_NAME` | Stable project identifier used for processes and infrastructure |
| `HARNESS_USE_WORKTREE` | Whether launch uses isolated worktrees by default |
| `HARNESS_PRIMARY_APP` | Primary per-slot application in the web profile |
| `HARNESS_AGENT_SLOT_MIN` / `MAX` | Legacy fallback for slot id range — canonical limits are in `.har/stages.json` (`agentSlots`) |

## Toolchain

| Variable | Meaning |
| --- | --- |
| `HARNESS_ECOSYSTEM` | `auto`, `node`, `python`, `go`, `rust`, `java`, `ruby`, `ios`, or `none` |
| `HARNESS_INSTALL_CMD` | Project-specific install override |
| `HARNESS_NODE_PACKAGE_MANAGER` | Pins the Node package manager: `npm`, `bun`, `pnpm`, or `yarn` (auto-detected when unset) |
| `HARNESS_PYTHON_VENV_DIR` | Python virtual environment path relative to the work directory |
| `DEVELOPER_DIR` | Optional Xcode developer directory |
| `HARNESS_XCODE_SCHEME` | iOS scheme |
| `HARNESS_XCODE_PROJECT` / `WORKSPACE` | Xcode project source |
| `HARNESS_SIMULATOR_NAME` | Simulator model each slot runs on; empty means the newest of the family |
| `HARNESS_BUNDLE_ID` | Application bundle identifier |

Provisioning records resolved values such as `NODE_BIN`, `NPM_BIN`, `PYTHON_BIN`,
`GO_BIN`, `CARGO_BIN`, `RUSTC_BIN`, `JAVA_HOME`, `RUBY_BIN`, and
`XCODEBUILD_BIN` in the slot environment.

### Node package managers

`node` projects install with bun, pnpm, yarn, or npm. The manager is taken from
`HARNESS_NODE_PACKAGE_MANAGER`, then the `packageManager` field in
`package.json`, then the lockfile (`bun.lock` → bun, `pnpm-lock.yaml` → pnpm,
`yarn.lock` → yarn, `package-lock.json` → npm).

When the declared manager is not installed, provisioning falls back to one that
is — so a bun repository still launches on an npm-only machine, and an npm
repository still launches on a bun-only machine. A substitute never migrates the
repository: any lockfile it writes is removed after the install.

`NPM_BIN` holds the resolved manager (use `${NPM_BIN:-npm} run <script>` in
verification steps) and `HARNESS_PKG_EXEC` holds the matching package runner
(`npx --yes`, `bunx`, `pnpm dlx`, or `yarn dlx`).

### iOS generated Xcode projects

Tuist, XcodeGen, and CocoaPods treat the `.xcodeproj` / `.xcworkspace` as a build
product, so a fresh session worktree has nothing for `xcodebuild` to open. When no
project file is present, launch runs the generator the repository declares —
`tuist generate` for `Project.swift`, `xcodegen generate` for `project.yml` — and
`pod install` whenever a `Podfile` is present and `Pods/` is missing. A generator
the repository needs but the machine lacks fails the launch by name instead of
surfacing later as an opaque *scheme not found* from `xcodebuild`.

`HARNESS_INSTALL_CMD` owns provisioning outright when set: the default generators
do not run behind it, and a failing override fails the launch.

`HARNESS_XCODE_WORKSPACE`, `HARNESS_XCODE_PROJECT`, `HARNESS_XCODE_SCHEME`, and
`HARNESS_BUNDLE_ID` stay adapt-time values in `.har/harness.env`. With both project
variables empty, verification auto-detects the project — ignoring the
`project.xcworkspace` nested inside every `.xcodeproj` and anything under `Pods/`.

## iOS simulator allocation

Each iOS slot creates `har-<project>-agent-<id>-<model>` at launch and deletes it at
teardown, on the newest installed runtime that supports the model.

| Variable | Meaning |
| --- | --- |
| `HARNESS_SIMULATOR_FAMILY` | `auto` (from the configured model), `iPhone`, or `iPad` |
| `HARNESS_SIMULATOR_UDID` | Runs every slot on one existing device instead of creating any |
| `HARNESS_SIMULATOR_SHARED` | Set `true` for one shared simulator, the pre-allocation behavior |

Launch writes `HARNESS_SIMULATOR_UDID`, `HARNESS_SIMULATOR_DEVICE_NAME` and
`HARNESS_IOS_DESTINATION=platform=iOS Simulator,id=<udid>` into the slot
environment, leaving `HARNESS_SIMULATOR_NAME` to mean the model everywhere; what a slot holds is tracked in `.har/simulators/agent-<id>.json`.

## Web ports and health

| Variable | Meaning |
| --- | --- |
| `HARNESS_FE_BASE_PORT` | Frontend base; slot default is base plus id × step |
| `HARNESS_API_BASE_PORT` | API base |
| `HARNESS_PORT_STEP` | Width of each slot's port lane |
| `HARNESS_HEALTH_CHECK_PATH` | Endpoint polled after launch |

Resolved `FE_PORT`, `API_PORT`, `DEBUG_PORT`, and preview URLs belong to the slot
registry and environment. Consumers should never assume the default remains free.

## Shared infrastructure

| Variable | Meaning |
| --- | --- |
| `HARNESS_INFRA_SERVICES` | Space-separated services from `docker-compose.agent.yml` |
| `HARNESS_TEMPLATE_DB` | Database cloned for each slot |
| `HARNESS_TEMPLATE_DBS` | Optional logical-name/template pairs for multiple stores |
| `HARNESS_DB_MIGRATE_CMD` | Idempotent schema command |
| `HARNESS_DB_SEED_CMD` | Seed command — once against the Postgres template DB, or once per slot at launch for file-backed databases |
| `HARNESS_DB_MINIMAL_BOOTSTRAP_CMD` | Optional small per-slot bootstrap |
| `HARNESS_INFRA_PORT_LANES` | Port lane per service: `<lane>=<default>:<scan_start>-<scan_end>` |

Generated web profiles declare lanes for `db`, `minio`, `minio-console`,
`browser`, `mailpit-web`, and `mailpit-smtp`. setup-infra.sh tries each lane's
default first and scans its range on conflict. (Pre-1.0
`HARNESS_<SERVICE>_PORT_DEFAULT/_SCAN_*` triplets are still honored as a
fallback.)

## Verification

| Variable | Meaning |
| --- | --- |
| `HARNESS_READINESS_CMD` | Optional usability smoke beyond a process health check |
| `HAR_SKIP_GATE` | Explicit commit-gate bypass; recorded and not for agent completion |
| `HAR_SKIP_WT_GUARD` | Explicit Claude worktree-guard bypass |

## Mission Control

| Variable | Meaning |
| --- | --- |
| `HAR_CONTROL_API_URL` | Override local dashboard API |
| `HAR_CONTROL_IMAGE` | Override Mission Control image |
| `HAR_CONTROL_IMAGE_TAG` | Override image version |
| `HAR_CONTROL_BUILD` | Build Mission Control from source |
| `HAR_CLOUD_API_KEY` | Hosted synchronization credential |

Treat credentials as shell or secret-manager values, never as committed
`harness.env` content.

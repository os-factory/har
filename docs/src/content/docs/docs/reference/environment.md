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
| `HARNESS_PYTHON_VENV_DIR` | Python virtual environment path relative to the work directory |
| `DEVELOPER_DIR` | Optional Xcode developer directory |
| `HARNESS_XCODE_SCHEME` | iOS scheme |
| `HARNESS_XCODE_PROJECT` / `WORKSPACE` | Xcode project source |
| `HARNESS_SIMULATOR_NAME` | Simulator model each slot runs on; empty means the newest of the family |
| `HARNESS_BUNDLE_ID` | Application bundle identifier |

Provisioning records resolved values such as `NODE_BIN`, `NPM_BIN`, `PYTHON_BIN`,
`GO_BIN`, `CARGO_BIN`, `RUSTC_BIN`, `JAVA_HOME`, `RUBY_BIN`, and
`XCODEBUILD_BIN` in the slot environment.

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
| `HARNESS_DB_SEED_CMD` | Template seed command |
| `HARNESS_DB_MINIMAL_BOOTSTRAP_CMD` | Optional small per-slot bootstrap |
| `HARNESS_DB_PORT_DEFAULT` | Preferred shared Postgres host port |
| `HARNESS_DB_PORT_SCAN_START` / `END` | Conflict fallback range |

Generated web profiles include the same default/scan pattern for optional MinIO,
browser, Mailpit web, and Mailpit SMTP ports.

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

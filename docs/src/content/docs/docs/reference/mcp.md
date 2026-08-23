---
title: MCP tools
description: Structured tools available from the HAR MCP server.
---

Start the server with `har mcp --repo <path>`. Every tool accepts an optional
`repo`; tools that act on a slot require `agentId`.

## Discovery and setup

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_describe_project` | `repo` | Manifest, stack hints, scripts, stages, and slot limits |
| `har_init_harness` | `repo`, `force`, `smoke`, `profile` (`default` \| `cli` \| `ios`) | Scaffold and validation result, plus a `docker` block (`cliInstalled`, `daemonRunning`, `version`, `warning`) — Docker is required for Mission Control and harness infra |
| `har_maintain` | `repo`, optional `finalize`, `summary` | Validation issues, template drift, and the maintenance bundle report; `finalize: true` records a completed manual adaptation in `.har/manifest.json` |
| `har_add_plugin` | `plugin` (bundled id, path, npm package, or git URL), optional `force`, `withCi` | Registered stage ids, files written, warnings, and next steps |

## Session lifecycle

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_preflight_environment` | `agentId` | Readiness, blockers, warnings (including untracked worktree paths), and whether launch is safe |
| `har_launch_environment` | `agentId`, optional `worktree`, `claude`, `resume`, `workUnitId`, `source`, `sourceUrl`, `title`, `parentWorkUnitId`, `relatedLinks` | Work directory, branch, work/attempt IDs, URLs, and normalized stage result |

Pass `workUnitId`, `source`, and `sourceUrl` when the task names a tracker issue or
ticket (short repo-scoped id such as `widget-123`, not a provider-prefixed composite).
Use `relatedLinks` or `har_add_work_unit_link` for secondary URLs (GitHub PR, mirrored
issue, Bitbucket). Omit work metadata for ad-hoc work with no tracker identity.
| `har_add_work_unit_link` | `workUnitId`, `source`, `url`, optional `label` | Append a related external link to an existing work unit |
| `har_recover_environment` | `agentId` | Resumed failed or partial launch |
| `har_get_status` | optional `agentId` | Structured slot status (same source as `har env status --json`): worktree, branch, dirty state, readiness, last run/verify. A pure read — writes no run records |
| `har_get_logs` | `agentId`, optional `service` | Recent service output |
| `har_complete_environment` | `agentId`, `skipVerify` | Validation, teardown, and retained branch |
| `har_teardown_environment` | `agentId`, `deleteBranch` | Teardown result |

Every launch creates a new session from the main checkout's current HEAD.
Occupied slots always block a new launch: call `har_get_status`, then
`har_complete_environment` or `har_teardown_environment` to free the slot,
then launch again. Occupied-slot errors include the upcoming base — launch
never chooses `main` for you. `resume=true` is only for a failed or starting
session (or use `har_recover_environment`); it is not a way to replace an
active session.

## Execution

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_run_stage` | `stageId` or `kind`, optional `agentId`, `args` | Normalized generic stage result |
| `har_run_verification` | `agentId`, `full` | Status, timing, and failed-step output (passing steps omit logs) |
| `har_doctor` | `repo` | Harness contract validation (same report as `har env doctor --json`): pass/fail checks plus findings with remedies; `isError` when the contract is broken |

Stage kinds are `setup`, `launch`, `verify`, `test`, `inspect`, `reset`,
`teardown`, and `custom`.

## Evidence

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_list_artifacts` | optional `stageId` | Files, reports, screenshots, traces, videos, and URLs |
| `har_list_runs` | optional `stageId`, `limit` | Persisted run records |
| `har_get_run` | `runId` | One normalized run record |

## Mission Control

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_control_up` | `repo`, `detach` | Starts local Mission Control and syncs remembered repositories |

## Recommended agent sequence

```text
har_describe_project
har_get_status
har_preflight_environment
har_launch_environment
har_run_verification
har_run_verification(full: true)
har_complete_environment
```

MCP and CLI share the same core execution service. The structured MCP result is not
a separate implementation of the harness.

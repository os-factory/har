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
| `har_init_harness` | `repo`, `force`, `auto`, `smoke`, `profile` | Scaffold and validation result |

## Session lifecycle

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_preflight_environment` | `agentId`, `confirmReplace`, `force` | Readiness, blockers, and whether launch is safe |
| `har_launch_environment` | `agentId`, `worktree`, `claude`, `confirmReplace`, `force`, `resume` | Work directory, branch, URLs, and normalized stage result |
| `har_recover_environment` | `agentId` | Resumed failed or partial launch |
| `har_get_status` | optional `agentId` | Slot, process, worktree, branch, and dirty state |
| `har_get_logs` | `agentId`, optional `service` | Recent service output |
| `har_complete_environment` | `agentId`, `skipVerify` | Validation, teardown, and retained branch |
| `har_teardown_environment` | `agentId`, `deleteBranch` | Teardown result |

Every launch creates a new session from the main checkout's current HEAD.
`confirmReplace` only confirms destroying the previous worktree on that slot —
it does not choose `main`. Prefer `har_complete_environment` /
`har_teardown_environment` when the prior task is finished, then launch.
Occupied-slot errors include the upcoming base. Dirty replacement additionally
requires `force`; agents should never set either without review and explicit
approval. Use recovery, not replacement, for a failed launch.

## Execution

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_run_stage` | `stageId` or `kind`, optional `agentId`, `args` | Normalized generic stage result |
| `har_run_verification` | `agentId`, `full` | Verification steps, output, timing, and status |

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

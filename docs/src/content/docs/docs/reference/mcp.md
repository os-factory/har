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
| `har_init_harness` | `repo`, `force`, `smoke`, `profile` (`default` \| `cli` \| `ios`) | Agent scaffold path (do not run `har onboard`). Returns the scaffold and validation result, plus a `docker` block (`cliInstalled`, `daemonRunning`, `version`, `warning`) — Docker is required for Mission Control and harness infra |
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
When the work id is only known after launch, call `har_bind_work_unit` from the slot.
| `har_add_work_unit_link` | `workUnitId`, `source`, `url`, optional `label` | Append a related external link to an existing work unit |
| `har_bind_work_unit` | `workUnitId`, `agentId` or `cwd` (path inside the slot work dir), optional `source`, `sourceUrl`, `title`, `parentWorkUnitId`, `relatedLinks` | Bind or change the work unit of a running slot (same as `har env work-bind`): a new attempt; a replaced unit keeps its attempt and evidence and is closed as abandoned |
| `har_recover_environment` | `agentId` | Resumed failed or partial launch |
| `har_get_status` | optional `agentId` | Structured slot status (same source as `har env status --json`): worktree, branch, dirty state, readiness, last run/verify. A pure read — writes no run records |
| `har_get_logs` | `agentId`, optional `service` | Recent service output |
| `har_complete_environment` | `agentId`, optional `verify` | Reuse last matching full validation (or re-run when `verify=true`), teardown, and retained branch |
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

## Factory lines

A **factory line** is a multi-station program with a cumulative gate. Line
stages are registered in `.har/stages.json` but are **never** added to
`verificationStages` — `har_run_verification` is unaffected by installing one.
Verification plugins (which *do* join verify) use `har_add_plugin` instead.

| Tool | Inputs | Result |
| --- | --- | --- |
| `har_line_create` | `id`, optional `title`, `description`, `stations`, `gateStage`, `optInEnv`, `force`, `personal` | Scaffolds `.har/lines/<id>/` (or the gitignored `.har/local/lines/<id>/` with `personal: true`) — manifest, program, gate stage, README — and returns its `scope`, files written and next steps |
| `har_line_promote` | `line` (a personal line id) | Line id, team `lineDirRel` and `programPath`, stage ids moved into `.har/stages.json`, `filesToCommit`, warnings, next steps, and `verificationStagesUnchanged: true`. One way: there is no demote |
| `har_add_line` | `line` (local id, path, npm package, or git URL), optional `force`, `personal` | Installed line id, `scope` (`team` or `personal`), stations, registered stage ids, files written, program path, adaptation prompt path, and `verificationStagesUnchanged: true` |
| `har_line_list` | — | Installed lines with title, description, stations, progress and `runAll` (the station and `force` that run every station), plus lines available to install. A line that cannot be read is listed as `unreadable` |
| `har_line_describe` | optional `line` | What a line checks and where it stands: description, stations with cumulative gate progress from run records, gate stages (description, registered, last run status), registered stages, any stage that leaked onto the verify plan, slots in flight, `runAll` and `runStationCommand`. Without `line`, every installed line (`{ lines }`; a broken one comes back as `unreadable`). A pure read — writes no run records |
| `har_run_line_gate` | `station`, optional `line`, `agentId`, `force` | Per-stage results for every gate stage tagged at that station or earlier |

`har_add_line` refuses a verification-plugin bundle, and `har_add_plugin`
refuses a line bundle — the two apply paths are deliberately not
interchangeable.

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

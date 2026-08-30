# Slot occupancy identity

A factory line ([#316](https://github.com/os-factory/har/issues/316)) over a real
product defect: after `har env complete 1` and a later `har env launch 1` for a
**new** task, Mission Control kept describing the previous session.

## The invariant

A **slot number** is a workstation. A **working session** is one occupancy of one
worktree.

- `--resume` / `recover` continues an occupancy — same key.
- `complete` / `teardown` then `launch` may reuse the number, but must mint a
  **new** occupancy: new purpose, new trajectory stream, no merge with the
  previous session key.

Occupied slots already block. That poka-yoke was never the bug — the bug was
that Mission Control's identity stayed slot-centric after the workstation was
freed.

## Stations

| Station | Question the gate keeps asking | Isolation |
|---|---|---|
| `S0` | After idle sync, `purpose` is null; relaunch does not keep occupancy A's summary | mocked prisma |
| `S1` | Trajectory/usage for occupancy B are not listed under occupancy A of the same slot | mocked prisma |
| `S2` | `complete` → `launch` writes a new session key; ingest does not prefer a stale `har.session_key` once the worktree changed | mocked prisma |
| `S3` | Two real occupancies of slot 1, real CLI, real database, isolated `HOME` | Docker |

## Run it

```bash
har line status occupancy-identity
har line gate S2 --line occupancy-identity   # S0 + S1 + S2 — fast, no Docker
har line gate S3 --line occupancy-identity   # + the sandbox lab
```

The gate is **cumulative**: `S3` runs `S0`–`S2` too. Adding a station may never
drop an earlier one's stages.

## Why S3 is containerised

Claude Code stores transcripts at `~/.claude/projects/<encoded-cwd>`. On a
laptop those survive teardown, and the usage harvest can re-attach them to the
next occupancy of the same slot. A green run there can mean "the machine was
clean" rather than "the invariant holds". A sandbox `HOME` removes that reading.

The jig is modelled on
[os-factory/otel-hook](https://github.com/os-factory/otel-hook)
`har-plugins/agent-lab`. Copy the jig, not the package — publishing
`@osfactory/agent-lab` waits until a second repo wants the same install.

## Not on verify

`occupancy-s0`…`occupancy-lab` are **registered** stages that are absent from
`verificationStages`. Routine `har env verify --full` does not start Docker and
is not slowed by this line. `har env doctor` fails if any of them ever reaches
the verify plan.

That is the kind split doing its job: if a check should gate *every* verify it
is a [verification plugin](https://github.com/os-factory/har-plugin), not a line.

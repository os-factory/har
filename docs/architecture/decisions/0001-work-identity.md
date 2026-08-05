# ADR 0001: Durable work identity and execution attempts

- Status: Accepted
- Date: 2026-07-23

## Context

HAR currently identifies reusable capacity (`agentId`), a transient slot session
(`sessionKey` in telemetry), individual runs, and exact-tree validations. None of
those identifiers answers which durable piece of externally planned work the
evidence belongs to.

HAR must add that correlation without becoming an issue tracker, planning system,
or coding methodology.

## Decision

HAR owns execution and proof. Humans, trackers, agents, and skill packs continue to
own intent, decomposition, implementation strategy, and review methodology.

The identity hierarchy is:

```
WorkUnit -> WorkAttempt -> slot session/worktree -> runs -> validation binding
```

### Work unit

`workUnitId` is a stable, caller-provided identifier scoped to one registered
repository. Prefer a short repo-scoped id (for example `widget-123` or `har-115`);
put the tracker provider in `source` and the canonical URL in `sourceUrl`. Legacy
composite ids such as `github:owner/repo#123` remain valid but are deprecated.

A durable work-unit record stores only immutable correlation metadata: optional
source, source URL, title, and parent work-unit ID.

Mutable tracker fields such as assignee, labels, priority, and tracker workflow
state are not copied into HAR.

HAR stores work-unit records in the main checkout under `.har/work-units/`.
These records are durable across slot teardown but remain repository-local. Mission
Control is a synchronized projection, not the source of truth. Moving or deleting
the checkout moves or deletes this local evidence unless it has been synchronized
elsewhere.

### Attempt

Each fresh launch bound to work gets an immutable UUID `attemptId`. An attempt is
the canonical identity for one slot session. Slot IDs are reusable capacity;
telemetry `sessionKey` is an observational correlation and is not authoritative.

The first release permits only one active attempt for a work unit. Parallel work is
represented by child work units.

Resuming a partial launch preserves its attempt ID. Replacing or relaunching creates
a new attempt.

### Evidence and status

Runs carry both `workUnitId` and `attemptId`. Telemetry usage/events carry the same
optional correlations. Existing records without work metadata remain valid.

Validation records remain reusable proof keyed by the exact Git tree hash. Because
the same tree can prove more than one work unit, validation records do not own a
work unit. A separate validation binding links a validation to an attempt.

Active, failed, and verified states are derived from slot, run, and validation
evidence. HAR stores explicit state only for business outcomes:

- `completed` must reference an attempt, a successful full validation, and its
  exact tree hash.
- `abandoned` records a decision time and optional reason.

Teardown is operational cleanup and never implies completion. Completed or
abandoned work is terminal in the first release; reopening requires a future
explicit contract that can preserve prior outcome history.

### Interfaces and compatibility

`har env launch` and `har_launch_environment` are canonical orchestration surfaces.
They accept work metadata, persist the work/attempt records, and propagate IDs.

Generated `launch.sh` scripts accept work and attempt IDs so direct script users can
preserve slot correlation. Raw scripts still do not create normalized run or
validation records; CLI/MCP is therefore required for complete evidence.

All new fields are optional on existing slot, run, validation, usage, event, and
sync schemas. Launch without work metadata behaves as before.

### Telemetry

Stable bounded identifiers may be emitted as `har.work_unit_id` and
`har.attempt_id`. Titles, URLs, and mutable tracker metadata are not OTEL resource
attributes, avoiding sensitive data leakage and unbounded cardinality.

## Consequences

- Mission Control can organize evidence around work without owning planning.
- Slot reuse and telemetry implementation details no longer affect work history.
- Validation proof can be reused safely across work units.
- Repository-local durability is intentionally weaker than a tracker or hosted
  database; provider import and conflict resolution remain future work.
- Queueing, dispatch, tracker adapters, and agent invocation are separate later
  decisions after real usage validates this contract.

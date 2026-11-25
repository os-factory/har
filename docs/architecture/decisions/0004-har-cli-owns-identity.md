# ADR 0004: The HAR CLI owns work identity, telemetry is stamped where it is produced

- Status: Proposed
- Date: 2026-11-25
- Builds on: [ADR 0001](0001-work-identity.md) (work identity), [ADR 0003](0003-session-slot-attribution.md) (session attribution)
- Related: #416 (HAR 2.0.0), #522 (fan-out at the producer), #525 (proof destinations), #369 (HQ sync needs Mission Control)
- Standard: [Factory Commits](https://github.com/os-factory/factory-commits), telemetry profile

## Context

HAR 2.0 aims to make HAR a producer of open standards that work without any HAR
server:

- agent and verification telemetry is standard OpenTelemetry, sent to any OTLP
  destination;
- each full verification becomes a Factory Commits proof, recorded in git and
  sent to proof destinations (#525);
- Mission Control (MC) and HQ are optional destinations, not required parts.
  #522 moves the telemetry fan-out to the producers, so MC no longer relays.

One responsibility has not moved: **linking**. Deciding which work unit,
attempt and factory run a piece of telemetry belongs to still happens inside MC.

- An agent usually starts in the main checkout and runs `har env launch` later.
  Its process never reads `.env.agent.<id>`, so its spans carry no
  `factory.work_unit.id` or `factory.attempt.id`. ADR 0003's evidence timeline
  links them after the fact, and that timeline runs only in MC.
- The `workspace` and `observed` bindings are derived from spans and exist only
  in MC's database. If that database is lost, trajectory rows can no longer be
  re-linked.
- HQ receives telemetry only through MC. `buildPortalPayload` reads no usage or
  events when MC is unreachable (#369). A user who connects HQ only gets runs and
  proofs, but no trajectory and no usage.
- A third-party destination (a Collector, Langfuse, a team backend) receives
  spans from sessions started in the main checkout with no work unit, and nothing
  can link them later.
- #522 keeps `factory.local.*` paths in the Resource whenever MC is a
  destination, because MC needs them for attribution. Third parties then
  receive those paths too.

A second problem is the link between telemetry and a factory run. A factory run
(`Factory-Run`, `predicate.run.id`) is created by `har env verify --full`. The
agent telemetry that produced the verified tree was emitted **before** that run
existed, so it cannot carry the run id. Today:

- the verification trace is linked: its trace id is derived from the validation
  id (`verificationTraceId = sha256("har-verify:" + id)[:32]`), so the predicate
  can name it before the trace is exported (`predicate.telemetry.traceId`);
- the `Factory-Run` trailer carries only the run id. The spec allows
  `; trace=<id>`, but HAR does not pass it;
- no rule says which agent sessions belong to a factory run. MC answers it with
  its own queries, and no other consumer can.

## Decision

### 1. The HAR CLI is the registrar

The CLI is the only component that creates work identity: work units, attempts,
factory runs, and the bindings between an agent session and an attempt. Every
other component (otel-hook, MC, HQ, any OTLP backend) reads those ids. None of
them creates or infers one.

The CLI can do this because it already knows:

- which repository, checkout and slot it runs in;
- which agent session called it. `src/core/agent-process.ts` walks the process
  tree up to the nearest `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` or
  `CURSOR_CONVERSATION_ID`. When the tree is ambiguous, no session is recorded,
  never the wrong one (ADR 0003);
- the work unit, attempt and run it is creating.

Records are append-only, and every id is deterministic or minted once, so
sending a record again is a no-op, never a conflict.

### 2. Session context: the CLI writes it, emitters read it

HAR keeps one **session context** file per agent session, on the machine running
the agent:

```
~/.har/sessions/<agent-tool>/<session-id>.json     (mode 0600, written atomically)
```

```json
{
  "version": 1,
  "agentTool": "claude_code",
  "sessionId": "8f0c…",
  "segments": [
    {
      "from": "2026-11-25T10:02:11.000Z",
      "to": null,
      "reason": "launch",
      "attributes": {
        "factory.work_unit.id": "416",
        "factory.work_unit.source": "github",
        "factory.attempt.id": "2e622700-…",
        "factory.slot.id": "1",
        "vcs.repository.url.full": "https://github.com/os-factory/har",
        "vcs.ref.head.name": "next-77b6-har-agent-1-w9jz"
      }
    }
  ]
}
```

- `har env launch` opens a segment for the calling session. `teardown` and
  `complete` close it (`to`). A later launch from the same session closes the
  open segment and opens a new one.
- `har env verify` adds no segment. It records "session S ran run R" in the run
  record (section 4).
- `attributes` holds only Factory Commits telemetry-profile and OTel semconv
  attributes. It never holds paths, prompts or secrets.
- A segment is in force from `from` until `to`. At any time, at most one
  segment of a session is open.

These segments are the `launch` and `release` bindings of ADR 0003, written
where any producer can read them. They are also synced as records (section 6),
so consumers can join data that was not stamped (section 3).

### 3. Telemetry is stamped where it is produced

otel-hook reads the session context on every hook event. It already runs as
one short process per event, so the read is one small file per event. It merges
the attributes of the segment in force at the event's timestamp into the
Resource of that export.

- The feature is generic in otel-hook: a context directory
  (`OTEL_HOOK_CONTEXT_DIR`) laid out by agent tool and session id, holding
  attribute maps. otel-hook knows nothing about work units or attempts, so any
  harness can use it.
- Context attributes override the same keys from `OTEL_RESOURCE_ATTRIBUTES`. A
  session that moves from slot 1 to slot 2 must stop reporting slot 1's attempt,
  even though its environment still names it.
- With no context file, or no segment in force, nothing is added. The session is
  working outside any attempt (for example exploring in the main checkout
  before launch), and its telemetry shows as unassigned. Before launch is not
  part of the attempt, by definition.
- Subagent events use their parent session's context.

As a result, every destination receives spans and logs that already carry
`factory.work_unit.id` and `factory.attempt.id` whenever an attempt was in force.
No destination has to link anything.

Two deliberate limits:

- **Worktree targets do not change the Resource.** otel-hook keeps reporting the
  worktree a tool event targets (`vcs.ref.head.name`, hashed worktree id) as span
  attributes. Touching a file in a worktree does not prove that the session works
  on that attempt, so only the CLI-recorded segments decide the Resource. A
  consumer may still use those span attributes, through ADR 0003's resolver, for
  sessions that never called `har`.
- **Provider-native telemetry is not stamped.** Claude Code's own metrics and
  `api_request` events come from the agent process, which HAR cannot change
  after it starts. Usage per attempt comes from the CLI's harvest, which reads
  the session context and stamps each usage observation. Native counters stay a
  cross-check, joinable by `session.id` and time against the synced segments.

### 4. Linking telemetry to a factory run

The correlation keys are the ones the proof already carries. No new key is
needed in git.

| Telemetry | Key to the factory run | How |
|---|---|---|
| Verification trace | `trace id = derive(run.id)` | Deterministic, so known before export. Written to `predicate.telemetry.traceId` **and** to the trailer: `Factory-Run: <run-id>; trace=<trace-id>` |
| Verification spans | `factory.run.id`, `cicd.pipeline.run.id`, `factory.git.tree` | Attributes on the run span, equal to `predicate.run.id` and the statement's `gitTree` |
| Agent session telemetry | `factory.attempt.id` + time | Stamped at emission (section 3). Equal to `predicate.workUnit.attemptId` |

**Run window.** The agent telemetry of factory run R is every record with
`factory.attempt.id = R.attempt` and a timestamp at or before `R.finishedOn`.
The window is cumulative from the start of the attempt, because R verifies a
tree that all earlier work in the attempt produced. A view may also show only
the slice since the previous run of the same attempt.

**Session refs in the run record.** At verify time, the CLI writes into the
run record (and the evidence manifest, section 5) the agent sessions whose
segments for this attempt overlap the run window:

```json
"sessions": [
  { "agentTool": "claude_code", "sessionId": "8f0c…", "from": "…", "to": "…", "ranVerify": true }
]
```

This lets a consumer that holds only provider-native telemetry, keyed by
`session.id`, find a run's sessions without the factory attributes.

**What we do not do:**

- Agent spans never carry a run id. The run does not exist while the agent
  works.
- Session ids never go into a trailer. A run usually covers several sessions
  (subagents, resumed sessions, several agents). Session ids are specific to
  each provider, and a verifier never needs them. The attempt id, already in the
  signed predicate, is the stable key.

### 5. Evidence manifest per factory run

A passing full verify produces, next to the statement, an **evidence manifest**:
a JSON document addressed by its SHA-256 digest.

- It holds the run id, tree, attempt, work unit, verification trace id, session
  refs (section 4), stage artifact digests, and the statement digest.
- It holds no prompts, logs, paths or work unit titles (the same rules as the
  proof, SPEC §6).
- The statement references it by digest, so a verifier can check that a copy
  from any store is the right one. Like `stages[].artifacts[]`, the digest is the
  proof and a URI is only a hint.
- The commit does not exist at verify time. Associating the run with a commit
  is a separate, later record (today's commit binding, and the HTTP receiver's
  second delivery with `commit`).

Manifests and statements go to the **proof destinations** of #525
(`mission-control`, `hq`, `git-notes`, and later any HTTP receiver). They are
retried and never block verify or a commit.

### 6. Servers store and display, they do not link

- **Telemetry:** otel-hook sends already-stamped OTLP to every destination
  (#522). MC and HQ are two of them.
- **Records:** the CLI sends work units, attempts, runs, validations, session
  segments, commit bindings, statements and manifests **directly** to each
  configured store, MC and HQ alike, with idempotent upserts. HQ no longer reads
  telemetry through MC (fixes #369).
- **MC and HQ** aggregate and display. A work unit view is a query:
  - attempts by `workUnitId`;
  - runs and proofs by attempt;
  - commits by the commit bindings of those runs;
  - trajectory, spans and usage by `factory.attempt.id`;
  - the run window by `finishedOn`.

  No timeline resolution is needed for stamped data.
- **ADR 0003's resolver** stays in MC as a fallback for data that is not stamped
  (an older otel-hook, sessions that never called `har`). It is removed when
  stamping is the minimum supported version.
- **`factory.local.*` is no longer needed for attribution.** The #522 trade-off
  goes away: local paths are stripped for every destination unless it opts in.

### 7. Coherence rules

1. **One writer per id.** Only the CLI creates work unit, attempt, run and
   segment ids. Emitters copy them, and stores index them.
2. **Append-only with deterministic ids.** Retries and resyncs are no-ops. A
   correction is a new record (a closed segment, a new attempt), never an edit
   in place.
3. **Same records everywhere.** Every store receives the same records and the
   same stamped telemetry. Any store can be rebuilt from git, `.har/` and the
   session context files.
4. **One clock per link.** Segment times and event timestamps come from the
   same machine, so the run window is computed on one clock.
5. **Proofs never need telemetry.** Verification uses only git and the
   statement. Telemetry and manifests help a person read a proof, they do not
   make it valid.

## Consequences

Positive:

- Any OTLP destination, including HQ alone, a Collector or Langfuse, gets data
  linked to work units and attempts with no HAR server running.
- MC becomes optional for every purpose. A future local HQ only needs to store
  and display, so no linking logic is duplicated across MC and HQ.
- A factory run links to its telemetry through keys already in the signed
  predicate, and the trailer can name the verification trace.
- The same rules work for any harness that writes session context and any
  backend that reads the telemetry profile.

Negative and costs:

- otel-hook needs a context-directory feature and a minimum version bump.
- One small file read per hook event.
- Sessions that never call `har` stay unassigned unless a consumer runs the
  fallback resolver. This is deliberate: HAR does not guess.
- Provider-native telemetry stays unstamped. Usage per attempt relies on the
  CLI harvest.
- The session context is machine-local. That fits how agents run today. A
  remote agent would need its own producer to write it.

## Implementation plan

1. **HAR CLI:** pass `--trace <verificationTraceId>` to `git factory trailers`
   when the verification trace is delivered to at least one receiver.
2. **HAR CLI:** write and close session context segments in
   `launch`/`teardown`/`complete`. Record session refs in the run record. Add the
   schema to `packages/schemas`.
3. **otel-hook:** add the context directory and merge rule (separate repo,
   new minimum version). HAR sets `OTEL_HOOK_CONTEXT_DIR` in the hook config.
4. **HAR CLI:** stamp harvested usage observations from the session context.
5. **HAR CLI:** write the evidence manifest at full verify and send it through the
   #525 proof destinations.
6. **HAR CLI → HQ:** send records directly to HQ, not through MC (#369).
   `/api/otel` and `/api/trajectory` stop depending on MC. HQ (fecore) ingests
   stamped OTLP or the same records.
7. **MC:** query attempt views by stamped attributes first. Keep ADR 0003 as the
   fallback. Strip `factory.local.*` for all destinations by default again.
8. **Factory Commits:** propose the profile and predicate changes below.

## Changes proposed to Factory Commits

These go through the spec's RFC process (issue first, then a PR open at least 7
days, with test vectors).

1. **Telemetry profile: new section "Linking telemetry to a factory run"**,
   replacing the current two-line "Linking a proof to telemetry". It states the
   table and the run window from section 4 as the normative strategy:
   - the verification trace by trace id;
   - verification spans by `factory.run.id` and `factory.git.tree`;
   - agent telemetry by `factory.attempt.id` and time, up to `run.finishedOn`.

   It also says why agent telemetry cannot carry the run id.
2. **Telemetry profile: stamping guidance.** A producer that binds an
   already-running agent session to an attempt SHOULD make the session's
   emitter add `factory.attempt.id` (and the work unit) from that point on. It
   SHOULD NOT add them before. A session context file is the recommended
   mechanism, with its layout as an informative appendix.
3. **Trace id derivation.** The run span's trace id SHOULD be derived from the
   run id with one standard function (for example
   `sha256("factory-run:" + run.id)[:32]`). Any tool can then find the
   verification trace from a `Factory-Run` trailer alone, even without
   `; trace=`. HAR would switch from its `har-verify:` prefix before 2.0.0 is
   released.
4. **Clarify the trailer.** `Factory-Run: …; trace=` names the verification run's
   trace, never an agent session trace.
5. **Predicate: run-level evidence.** Add an optional
   `evidence[]: { name, digest: { sha256 }, uri?, mediaType? }`, like
   `stages[].artifacts[]` but for the whole run. The evidence manifest from
   section 5 is its first use.
6. **Evidence manifest profile (new, optional).** Schema for the manifest:
   - run, tree and attempt ids;
   - verification trace id;
   - session refs `{ agentTool, sessionId, from, to }`;
   - stage artifact digests;
   - privacy rules equal to SPEC §6.

   Session ids are not content, but the profile should say they may identify a
   provider account and are optional.
7. **HTTP receiver profile:** allow a manifest delivery next to `attestations[]`,
   idempotent by digest, so MC, HQ and third-party stores receive the evidence
   the same way.
8. **Conformance:** test vectors for a trailer with `; trace=`, a statement with
   `evidence[]`, and the trace id derivation.

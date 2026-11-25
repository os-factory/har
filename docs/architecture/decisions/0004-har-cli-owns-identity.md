# ADR 0004: The HAR CLI owns work identity, telemetry is stamped where it is produced

- Status: Proposed
- Date: 2026-11-25
- Builds on: [ADR 0001](0001-work-identity.md) (work identity), [ADR 0003](0003-session-slot-attribution.md) (session attribution)
- Followed by: [ADR 0005](0005-ingest-contract-v2.md) (what receivers store and how)
- Related: #416 (HAR 2.0.0), #522 (fan-out at the producer), #525 (proof destinations), #369 (HQ sync needs Mission Control), os-factory/otel-hook#67 (model and tokens on generations), os-factory/otel-hook#68 (Claude Code subagent tokens)
- Standard: [Factory Commits](https://github.com/os-factory/factory-commits) telemetry profile, os-factory/factory-commits#15 and #16

## Context

HAR 2.0 aims to make HAR a producer of open standards that work without any HAR
server:

- agent and verification telemetry is standard OpenTelemetry, sent to any OTLP
  destination;
- each full verification becomes a Factory Commits proof, recorded in git and
  sent to proof destinations (#525);
- Mission Control (MC) and HQ are optional destinations, not required parts.
  #522 moved the telemetry fan-out to the producers, so MC no longer relays.

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

### Two kinds of "run"

HAR has two ids that are both called a run. This ADR always means the second.

| Id | Created | Cardinality | Used by |
|---|---|---|---|
| Run record (`.har/runs/…json`) | Every `har env …` invocation | One per command | Operation history |
| **Factory run** (validation id) | `har env verify` | One per verified tree, reused when the same tree is verified again | `Factory-Run` trailer, `predicate.run.id`, MC's `verificationRun.runId` |

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
- the work unit, attempt and factory run it is creating.

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

The schema lives in `packages/schemas` and is versioned. It is a format other
tools read, so it is fixed before 2.0.0 (section 8).

**Opening.** `har env launch` opens a segment for the calling session. A later
launch from the same session closes its open segment and opens a new one. At any
time, at most one segment of a session is open.

**Closing.** Teardown and complete are often run by a person from a terminal, not
by the agent session, and a session that crashes never closes anything itself.
So closing is keyed by the attempt, not by the caller:

- `har env teardown` and `har env complete` close **every** open segment whose
  `factory.attempt.id` is the attempt being ended, in every session file,
  whichever process runs them.
- A segment whose attempt has already ended is treated as closed by every
  reader, even if its `to` is still empty (for example after a crash between
  ending the attempt and writing the files). The CLI repairs such segments on
  its next write.

**Content.** `attributes` holds only Factory Commits telemetry-profile and OTel
semconv attributes. It never holds paths, prompts or secrets. `har env verify`
adds no segment. It records which sessions worked on the factory run (section 4).

These segments are the `launch` and `release` bindings of ADR 0003, written
where any producer can read them. They are also sent as records
([ADR 0005](0005-ingest-contract-v2.md)), so consumers can join data that was
not stamped.

### 3. Telemetry is stamped where it is produced

otel-hook reads the session context on every hook event. It already runs as
one short process per event, so the read is one small file per event. It adds
the attributes of the segment in force at the event's timestamp to **every
record it emits for that event**: spans, log records and metric points.

- **Where it lives in otel-hook.** otel-hook keeps providers free of files and of
  state between hook calls. The context read is therefore a core step, next to
  the payload enrichment step added in os-factory/otel-hook#67, not provider
  code. It is generic: a context directory laid out by agent tool and session
  id, holding attribute maps. otel-hook knows nothing about work units or
  attempts, so any harness can use it.
- **How HAR turns it on.** Claude Code strips `OTEL_*` variables from hook
  processes, so the context directory is set in the otel-hook config file HAR
  writes (or a hook command flag), never through an environment variable.
- **Precedence.** Context attributes override the same keys from the Resource. A
  session that moves from slot 1 to slot 2 must stop reporting slot 1's attempt,
  even though its environment still names it. This matches the precedence rule
  in the telemetry profile (os-factory/factory-commits#16).
- **No segment, no stamp.** With no context file, or no segment in force, nothing
  is added. The session is working outside any attempt (for example exploring in
  the main checkout before launch), and its telemetry shows as unassigned.
  Sessions that never call `har` stay unassigned: HAR does not guess.
- Subagent events use their parent session's context.

**Usage per attempt comes from stamped generation spans.** Since
os-factory/otel-hook#67, otel-hook generation spans carry the model and the
turn's token counts. Stamped with the attempt, they are the main source of
usage per attempt, for every provider and every destination, with no harvest
and no MC needed. Two gaps remain, handled in
[ADR 0005](0005-ingest-contract-v2.md):

- Claude Code subagent tokens are missing from turn totals until
  os-factory/otel-hook#68 lands. Until then MC keeps booking Claude Code usage
  from Claude Code's native telemetry.
- Hooks report no cost, so receivers price tokens themselves.

Provider-native telemetry and the CLI harvest become a cross-check and a
fallback. This settles the double-counting question: a receiver books each
provider from exactly one source, chosen by `otelhook.provider.id`.

**Worktree targets do not change the attributes.** otel-hook keeps reporting the
worktree a tool event targets (`vcs.ref.head.name`, hashed worktree id) as span
attributes. Touching a file in a worktree does not prove that the session works
on that attempt, so only the CLI-recorded segments decide the work identity. A
consumer may still use those span attributes, through ADR 0003's resolver, for
sessions that never called `har`.

### 4. Linking telemetry to a factory run

The correlation keys are the ones the proof already carries. No new key is
needed in git.

| Telemetry | Key to the factory run | How |
|---|---|---|
| Verification trace | `trace id = derive(run.id)` | `sha256("factory-run:" + run.id)[:32]`, the derivation proposed in os-factory/factory-commits#16. Known before export. Written to `predicate.telemetry.traceId` **and** to the trailer: `Factory-Run: <run-id>; trace=<trace-id>` |
| Verification spans | `factory.run.id`, `cicd.pipeline.run.id`, `factory.git.tree` | Attributes on the run span, equal to `predicate.run.id` and the statement's `gitTree` |
| Agent session telemetry | `factory.attempt.id` + time | Stamped at emission (section 3). Equal to `predicate.workUnit.attemptId` |

**Run window.** The agent telemetry of factory run R is every record with
`factory.attempt.id = R.attempt` and a timestamp at or before `R.finishedOn`.
The window is cumulative from the start of the attempt, because R verifies a
tree that all earlier work in the attempt produced. A view may also show only
the slice since the previous factory run of the same attempt.

**Session refs on the factory run.** At verify time, the CLI adds to the
**factory run** (keyed by the validation id, not the per-invocation run record)
the agent sessions whose segments for this attempt overlap the run window:

```json
"sessions": [
  { "agentTool": "claude_code", "sessionId": "8f0c…", "from": "…", "to": "…", "ranVerify": true }
]
```

When the same tree is verified again, the list is merged, not replaced. This
lets a consumer that holds only provider-native telemetry, keyed by
`session.id`, find a run's sessions without the factory attributes.

**What we do not do:**

- Agent spans never carry a run id. The run does not exist while the agent
  works.
- Session ids never go into a trailer. A run usually covers several sessions
  (subagents, resumed sessions, several agents). Session ids are specific to
  each provider, and a verifier never needs them. The attempt id, already in the
  signed predicate, is the stable key.

### 5. Evidence

Stage logs and artifacts are evidence of a factory run. The proof lists them by
SHA-256 (`stages[].artifacts[]`), so a copy from any store can be checked
against it. How they are captured, capped and stored is decided in
[ADR 0005](0005-ingest-contract-v2.md).

A run-level **evidence manifest** (run, tree, attempt, verification trace id,
session refs, stage artifact digests) is deferred to a later Factory Commits RFC
(the follow-up in os-factory/factory-commits#15). Until then the session refs
travel as part of the factory run record.

### 6. Servers store and display, they do not link

- **Telemetry:** otel-hook sends already-stamped OTLP to every destination
  (#522). MC and HQ are two of them.
- **Records:** the CLI sends work units, attempts, factory runs, session
  segments, commit bindings, proofs and evidence **directly** to each configured
  receiver, MC and HQ alike, with idempotent upserts. HQ no longer reads
  anything through MC (fixes #369). The contract is
  [ADR 0005](0005-ingest-contract-v2.md).
- **MC and HQ** aggregate and display. A work unit view is a query:
  - attempts by `workUnitId`;
  - factory runs and proofs by attempt;
  - commits by the commit bindings of those runs;
  - trajectory, spans and usage by `factory.attempt.id`;
  - the run window by `finishedOn`.

  No timeline resolution is needed for stamped data.
- **ADR 0003's resolver** stays in MC as a fallback for data that is not stamped
  (an older otel-hook, sessions that never called `har`). It is removed when
  stamping is the minimum supported version. HQ does not port it.
- **`factory.local.*` is no longer needed for attribution.** The #522 trade-off
  goes away: local paths are stripped for every destination unless it opts in.

### 7. Coherence rules

1. **One writer per id.** Only the CLI creates work unit, attempt, factory run
   and segment ids. Emitters copy them, and stores index them.
2. **Append-only with deterministic ids.** Retries and resyncs are no-ops. A
   correction is a new record (a closed segment, a new attempt), never an edit
   in place.
3. **Same records everywhere.** Every receiver gets the same records and the
   same stamped telemetry. Any receiver can be rebuilt from git, `.har/` and the
   session context files.
4. **One clock per link.** Segment times and event timestamps come from the
   same machine, so the run window is computed on one clock.
5. **Proofs never need telemetry.** Verification uses only git and the
   statement. Telemetry and evidence help a person read a proof, they do not
   make it valid.

### 8. What must land before 2.0.0

The changes split by whether they fix a format other tools depend on.

**Formats, required before 2.0.0** (changing them later is breaking):

- the verification trace id switches to the `factory-run:` prefix;
- `; trace=<id>` is written in the `Factory-Run` trailer;
- the session context file schema (version 1);
- #525's default switch: proofs go to MC and HQ, git notes become opt-in.

**Additive, planned for 2.0.0** (each can slip to a 2.x minor without breaking
anything, because the formats above already allow it):

- writing and closing segments, and otel-hook stamping;
- sending records, proofs and evidence directly to HQ;
- stage log capture and evidence upload ([ADR 0005](0005-ingest-contract-v2.md)).

Decoupling MC from HQ is the goal of 2.0.0, so the additive items are planned
for it. The split only says which items are allowed to slip.

## Consequences

Positive:

- Any OTLP destination, including HQ alone, a Collector or Langfuse, gets data
  linked to work units and attempts with no HAR server running.
- Usage per attempt is available for every provider from stamped generation
  spans, with no harvest and no MC.
- MC becomes optional for every purpose. A future local HQ only needs to store
  and display, so no linking logic is duplicated across MC and HQ.
- A factory run links to its telemetry through keys already in the signed
  predicate, and the trailer names the verification trace.
- The same rules work for any harness that writes session context and any
  backend that reads the telemetry profile.

Negative and costs:

- otel-hook needs the context-directory step and a minimum version bump.
- One small file read per hook event.
- Sessions that never call `har` stay unassigned unless a consumer runs the
  fallback resolver. This is deliberate.
- The session context is machine-local. That fits how agents run today. A
  remote agent needs its own producer to write it; the near-term case is an
  agent in a devcontainer, which needs the sessions directory mounted or a HAR
  CLI inside the container.

## Implementation plan

Formats first (section 8), then the additive work.

1. **HAR CLI:** switch `verificationTraceId` to the `factory-run:` prefix and
   pass `--trace` to `git factory trailers`.
2. **HAR CLI:** add the session context schema to `packages/schemas`. Write
   segments in `launch`, close them by attempt in `teardown`/`complete`. Record
   session refs on the factory run.
3. **otel-hook:** add the context directory as a core step next to the payload
   enrichment of #67, configured by file or flag. New minimum version.
4. **HAR CLI:** pin that otel-hook version and set the context directory in the
   config it writes.
5. **HAR CLI:** send records, proofs and evidence directly to each receiver
   ([ADR 0005](0005-ingest-contract-v2.md)). Remove the MC → HQ path (#369).
6. **MC:** query attempt views by stamped attributes first. Keep ADR 0003 as the
   fallback. Strip `factory.local.*` for all destinations by default again.
7. **Factory Commits:** os-factory/factory-commits#16 (linking strategy, trace id
   derivation, `trace=`), then the evidence manifest as a follow-up RFC.

## Changes proposed to Factory Commits

Tracked in os-factory/factory-commits#15.

In os-factory/factory-commits#16:

1. **Telemetry profile: "Linking telemetry to a factory run"**, replacing the
   two-line "Linking a proof to telemetry". The verification trace by trace id,
   verification spans by `factory.run.id` and `factory.git.tree`, agent
   telemetry by `factory.attempt.id` and the run window. It also says why agent
   telemetry cannot carry the run id.
2. **Stamping guidance.** A producer that binds an already-running session to an
   attempt SHOULD make the session's emitter add the work identity from that
   point on, and SHOULD NOT add it before. Record attributes override the
   Resource. A session context file is given as an informative example.
3. **Trace id derivation**: `sha256("factory-run:" + run.id)[:32]`, SHOULD when
   the producer starts the trace. Explicit ids take precedence.
4. **The trailer's `trace=`** names the verification run's trace, never an agent
   session, and equals `telemetry.traceId` when both are present.

Follow-up RFC:

5. **Predicate: run-level evidence**, an optional
   `evidence[]: { name, digest: { sha256 }, uri?, mediaType? }`.
6. **Evidence manifest profile**: run, tree and attempt ids, verification trace
   id, session refs `{ agentTool, sessionId, from, to }`, stage artifact
   digests, with the privacy rules of SPEC §6. Session ids are optional because
   they may identify a provider account.
7. **HTTP receiver profile:** accept manifest deliveries, idempotent by digest.
8. **Conformance:** test vectors for `evidence[]`.

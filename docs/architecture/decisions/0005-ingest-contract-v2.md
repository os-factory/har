# ADR 0005: One ingest contract for every HAR receiver

- Status: Proposed
- Date: 2026-11-25
- Builds on: [ADR 0004](0004-har-cli-owns-identity.md) (the CLI owns work identity, telemetry is stamped where it is produced)
- Related: #416 (HAR 2.0.0), #369 (HQ sync needs Mission Control), #522 (fan-out at the producer), #525 (proof destinations), os-factory/otel-hook#67, os-factory/otel-hook#68
- Standard: [Factory Commits](https://github.com/os-factory/factory-commits) (proofs, telemetry profile)

## Context

ADR 0004 makes the CLI the only component that creates ids and links data. This
ADR decides what the CLI sends, where, and what a receiver stores.

Today the data reaches HQ in a chain:

```
CLI ──records──▶ Mission Control ──har control sync──▶ HQ  (sync, otel and trajectory JSON endpoints)
otel-hook ─OTLP─▶ Mission Control
```

- **HQ depends on Mission Control (MC).** HQ's telemetry is a JSON copy of MC's
  rows, sent by `har control sync`, so HQ gets nothing while MC is down (#369).
- **Two different contracts.** MC takes OTLP plus CLI records. HQ takes a
  separate JSON shape built from MC's database. Every new field is added twice.
- **The MC data model grew by accretion.** `Run`, `ChangeBatch`,
  `ValidationBinding`, `ValidationCommitBinding`, `VerificationRun`,
  `VerificationStage`, `SessionSlotBinding`, `UsageObservation`,
  `SessionReportedUsage` and `AgentSessionUsage` overlap. A factory run is spread
  over three tables.
- **Cost is computed in one place.** MC prices tokens with
  [genai-prices](https://github.com/pydantic/genai-prices)
  (`packages/schemas/src/model-pricing.ts`), and HQ stores whatever cost the
  client sends.
- **Proofs live only in git notes.** MC stores a statement digest, HQ nothing.
- **Evidence is partly kept.** A run record holds the verify command's stdout
  and stderr (a few hundred bytes). Stage artifacts stay in the slot's
  `.har/artifacts/`, which MC lists from disk. Neither reaches HQ.

## Decision

### 1. One contract, several receivers

A **receiver** is any server that takes HAR data: MC, HQ, or a third-party
implementation. Every receiver implements the same contract, **ingest v2**,
defined once as Zod schemas in `packages/schemas` (`ingest-v2.ts`).

- MC is the **reference implementation**. Each contract change lands in MC first,
  with contract tests that any receiver can run.
- HQ implements the same contract in its own codebase. Duplicating code between
  MC and HQ is accepted; diverging from the contract is not.
- A receiver never forwards to another receiver. The CLI and otel-hook send to
  each one directly (ADR 0004 section 6).

### 2. Endpoints

Paths are relative to the receiver's **ingest base URL**, which is the only
thing a destination configures. MC's is `http://localhost:3847/api`; a hosted
receiver picks its own (for example `https://…/ingest`).

| Endpoint | Body | Idempotent by |
|---|---|---|
| `POST otel/v1/traces`, `otel/v1/logs`, `otel/v1/metrics` | Standard OTLP over HTTP, protobuf or JSON | trace id + span id; log record id; metric series |
| `POST v2/records` | A batch of typed records (section 3) | each record's natural id |
| `POST v2/proofs` | DSSE envelopes of Factory Commits statements | statement digest, recomputed by the receiver |
| `POST v2/evidence/missing` | A list of SHA-256 digests; the reply lists the ones the receiver lacks, with an upload URL each | — |
| `PUT v2/evidence/{sha256}` | The file bytes (or the returned upload URL) | SHA-256, checked by the receiver |
| `GET v2/capabilities` | Contract version and supported signals | — |

- For MC the OTLP paths resolve to its existing `/api/otel/v1/…` routes, so OTLP
  exporters already pointed at MC keep working.
- `GET v2/capabilities` lets `har env doctor` say clearly when a receiver does
  not support v2 yet, instead of failing on the first upload.
- Authentication is the receiver's choice. MC listens on localhost without
  credentials. A hosted receiver uses an ingest key sent as a request header,
  which otel-hook sends through `headers` with an `env:` reference (section 6).

### 3. Data model v2

The records the CLI sends, and the tables a receiver keeps. Names are the
contract's; a receiver may name its tables differently.

| Record | Key | Holds | Replaces in MC |
|---|---|---|---|
| `WorkUnit` | `workUnitId` | source, url, title, related links | same |
| `Attempt` | `attemptId` | work unit, slot, branch, base commit | `WorkAttempt` |
| `SessionSegment` | session + `from` | agent tool, session id, attempt, `from`, `to` (ADR 0004 section 2) | `SessionSlotBinding` |
| `FactoryRun` | validation id | attempt, tree, verdict, policy, factory line and station, trace id, start and end, session refs, stages | `ChangeBatch` + `VerificationRun` + `ValidationBinding` |
| `StageResult` | factory run + stage id | status, added by, duration, log digest, artifact digests | `VerificationStage` |
| `CommitBinding` | commit SHA | tree, factory run, proof digest, branch | `ValidationCommitBinding` |
| `Attestation` | statement digest | the envelope as received, tree, verdict, trust, signer | new |
| `EvidenceBlob` | SHA-256 | size, media type, storage location | new |

Telemetry is stored from OTLP, not from records:

- spans and log records keep their attributes, with `factory.work_unit.id`,
  `factory.attempt.id`, `factory.run.id` and `session.id` as indexed columns;
- the agent trajectory is derived at ingest from OTLP, as MC's trajectory
  ledger does today;
- usage and cost are derived at ingest (section 5).

`Run`, the per-command operation history, stays as it is. It is not part of the
linking model.

A work unit view is then a fixed set of joins, the same in every receiver:

```
WorkUnit ─▶ Attempt ─┬─▶ FactoryRun ─┬─▶ StageResult ─▶ EvidenceBlob
                     │               ├─▶ Attestation ─▶ CommitBinding
                     │               └─▶ verification trace (trace id)
                     └─▶ spans, logs, trajectory, usage (factory.attempt.id, up to FactoryRun.finishedOn)
```

### 4. Evidence: stage logs and artifacts

- **Stage logs.** The CLI keeps each stage's combined stdout and stderr, capped
  to the **last 1 MiB**. When output is longer, the file starts with one line
  saying how many bytes were dropped. The file is written to
  `.har/artifacts/<factory-run-id>/<stage-id>.log` in the slot.
- **Artifacts.** Files a stage writes under `.har/artifacts/` (screenshots,
  reports) are evidence as they are.
- **In the proof.** Each file is listed in `stages[].artifacts[]` with its
  SHA-256, as the predicate already allows. The digest covers the file as kept,
  tail included. A verifier never needs the files; a person reading the proof
  can check any copy against the digest.
- **Upload.** After a passing full verify, the CLI asks each receiver which
  digests it lacks and uploads only those. Uploads are queued and retried like
  telemetry, and never block verify or a commit.
- **Storage** is the receiver's choice: MC keeps files on local disk under its
  data directory, a hosted receiver uses object storage. Retention may differ by
  receiver. Expired evidence never makes a proof invalid.

### 5. Usage and cost

**One source per provider.** A receiver books each provider's usage from exactly
one source, chosen by `otelhook.provider.id`, so nothing is counted twice:

| Provider | Source in 2.0 | Later |
|---|---|---|
| Claude Code | Claude Code's native telemetry (`api_request` events and metrics), as MC does today | otel-hook generation spans and metrics, once os-factory/otel-hook#68 adds subagent tokens. Native export is then turned off |
| Codex, Cursor, Gemini and others | otel-hook generation spans and metrics | same |

Usage per attempt comes from the stamped generation spans (ADR 0004 section 3).
The CLI harvest stays as a cross-check.

**OTLP metrics.** otel-hook metrics are running totals. A receiver stores the
**latest value per series**, never the sum of the points. MC's metrics receiver
accepts otel-hook metrics only for providers in the "otel-hook" row above.

**Cost is computed by the receiver.** Hooks report no cost, and a client-sent
cost cannot be checked. Every receiver prices tokens at ingest:

- with genai-prices, through the shared `model-pricing.ts` so MC and HQ give the
  same number;
- a cost the provider itself reported (for example Claude Code's) wins over the
  estimate, and is stored as reported;
- each priced row records which genai-prices version priced it, so a number can
  be explained later.

### 6. Destinations and the otel-hook config

The CLI keeps **one destination list** for everything it sends, in the existing
`~/.har/destinations` directory. Each destination says what it accepts:

| Preset | OTLP signals | Records, proofs, evidence |
|---|---|---|
| `mission-control` | traces, logs; metrics for otel-hook providers only | yes |
| `hq` | traces, logs, metrics | yes |
| `git-notes` | — | proofs only (opt-in) |
| `otlp` (Langfuse, a Collector, Datadog…) | traces, logs, metrics | no |

#525's proof destinations are this list, not a second one. Each destination has
its own retry queue and its own line in `har telemetry status` and
`har env doctor`.

The otel-hook config HAR writes follows from the list:

- otel-hook pinned to **0.11.0 or later** (today 0.9.0);
- one `exporter.destinations[]` entry per destination, with its `signals`;
- `providers.claudeCode.readTranscriptUsage: true`, so Claude Code sessions get
  token metrics (hooks carry no token counts; otel-hook reads them from the
  transcript at Stop);
- identity (`session.id`, `factory.*`) and metrics settings passed by config file
  or hook flag, never by `OTEL_*` variables, which Claude Code strips from hooks;
- `includeSessionId` exposed per destination, for backends where one series per
  session is too many;
- status and doctor reuse `otel-hook doctor`'s per-destination metrics endpoint
  and queue.

### 7. Deprecation of the v1 paths

Receivers move to v2 without breaking 1.x CLIs.

- **MC** ships with the CLI, in the same version. MC 2.0 migrates its database in
  place to the v2 model and drops `har control sync` to HQ. There is no period
  where MC serves both.
- **A hosted receiver** (HQ) adds the v2 endpoints next to the v1 ones and keeps
  v1 working for 1.x CLIs:
  1. **2.0.0:** v2 endpoints live before the 2.0.0 CLI is released. v1 endpoints
     are frozen (no new fields) and answer with `Deprecation` (RFC 9745),
     `Sunset` (RFC 8594) and a `Link` to the upgrade guide.
  2. **1.x patch:** the 1.x CLI prints an upgrade notice when it sees the
     `Deprecation` header.
  3. **Sunset:** no earlier than six months after 2.0.0, and only when v1 traffic
     is low. v1 endpoints then answer `410 Gone` with the upgrade command. v1
     data stays readable.
- The CLI 2.0 speaks only v2. A receiver without v2 is reported by doctor, not
  silently skipped.

### 8. Decisions made during implementation

The first implementation (the CLI, otel-hook, Mission Control, and a hosted
receiver run against the same contract tests) settled the points this ADR left
open. Where the ADR was silent, Mission Control's behavior decided.

**Keys and records**

- Work ids are scoped to a repository. `WorkUnit` and `Attempt` carry
  `repositoryUrl` (credential-free, `null` without a remote, never a local
  path). The `WorkUnit` key is (repository, `workUnitId`); receivers normalize
  the URL to its lowercased host and path.
- Receivers join records by natural keys, with no foreign keys between them, so
  a batch may arrive in any order. A receiver keeps an attempt's repository when
  a later record of the same attempt has none.
- `FactoryRun.stages` is the ordered list of stage ids; status and evidence live
  in `StageResult`. `policy` is `{ id, digest?, required[] }`. A `FactoryRun`
  holds the latest verify of its tree; session refs accumulate across verifies.
- A `StageResult` record wins over the verification span for the same stage. A
  verification trace that arrives after its records joins the existing factory
  run.
- `SessionSegment` carries `attemptId`, equal to `attributes["factory.attempt.id"]`.
  Its key is (agent tool, session id, `from`). Segments are half-open,
  `[from, to)`, ordered and non-overlapping, and only the last one may be open.
- The CLI sends no `EvidenceBlob` or `Attestation` records. A receiver derives
  them from evidence uploads and `v2/proofs`.
- Receivers stamp `CommitBinding` and `WorkUnit` with the time they first saw
  them, because the records carry none.

**Wire format**

- Evidence digests are bare 64-character hex (they appear in URL paths);
  statement digests keep the `sha256:` prefix.
- `uploadUrl` may be absolute or relative to the ingest base. Uploads go through
  the receiver, not a presigned storage URL, because the receiver must reject a
  wrong digest (400, 409 or 422; the digest stays missing).
- An invalid body gets 400 or 422. A receiver-side failure gets 5xx, which the
  CLI retries.
- The proofs body is `{ envelopes: [] }`. An `Attestation` whose envelope does not
  hash to its digest rejects the whole batch with 422.
- Capabilities are `{ contractVersion: "2", signals, recordTypes, proofs,
  evidence, maxEvidenceBytes? }`. Unknown fields are ignored everywhere.
- Read APIs (work unit view, factory run, proof by digest, evidence by digest)
  are not part of the ingest contract. Mission Control serves them under
  `/api/v2/`, and each receiver picks its own paths and authentication.

**Evidence**

- A stage log file is at most 1 MiB **including** its header line,
  `[har] <N> bytes dropped, last <K> bytes kept`. Output of exactly 1 MiB is
  kept whole, with no header. The cut never starts inside a UTF-8 sequence.
- A file belongs to a stage when it is new or changed under `.har/artifacts/`
  between snapshots taken just before and just after the stage.
- In the predicate, `stages[].artifacts[]` is `{ name, digest: { sha256 } }`.
- The CLI copies evidence bytes into each destination's queue at verify time,
  so teardown never loses them. Evidence is sent only after a passing full
  verify. An expired blob counts as missing and can be uploaded again.

**Destinations and stamping**

- Each destination keeps its own retry queue. 408, 429, 5xx, network errors,
  401/403 and 404/405/501 are retried, so nothing is lost before a receiver is
  upgraded. Other 4xx responses go to a dead-letter directory. Entries expire
  after 14 days.
- Work identity (`factory.attempt.id`, `factory.work_unit.*`, `factory.slot.id`)
  no longer goes in the agent's environment. Only the session context stamps it,
  so records outside a segment carry none. `factory.local.*` is stripped for
  every destination unless it opts in.
- otel-hook trusts a segment's `to` and knows nothing about attempts. The CLI
  closes an attempt's segments **before** it records the attempt's end, and
  repairs stale segments on its next write.
- `har env work-bind` with the slot's own work unit opens a segment (reason
  `join`) for the calling session, so a second or resumed session can join a
  running attempt.
- otel-hook has one global `includeSessionId` and no per-destination provider
  filter. HAR writes the AND of the per-destination settings. (Before the
  round-2 decisions below, Mission Control also dropped Claude Code's otel-hook
  metrics; it now keeps them.)
- In otel-hook, the worktree a tool event targets keeps its own
  `vcs.ref.head.name` on that span. The session context sets only the work
  identity.
- Git notes are written only with a `git-notes` destination (or an explicit
  `HAR_FACTORY_PROOF=notes…`). The attestation is still built and sent to
  receivers.

**Usage**

- A receiver stores the latest value of each OTLP metric series, keyed by
  sha256 of (metric name, sorted resource attributes, sorted point attributes).
  A late, older point never replaces a newer one, and delta series are stored
  the same way.
- *Superseded by "Round 2" below:* Claude Code usage first came only from its
  native `api_request` events, and receivers ignored Claude Code's otel-hook
  generations for usage.
- Every priced row records `costSource` (`reported` or `estimated`) and
  `pricedWith` (`genai-prices@<version>`). Committed test vectors
  (`packages/schemas/pricing-vectors.json`) keep receivers in agreement.

**Round 2: otel-hook is the only agent source, the CLI speaks only v2**

These supersede section 5's Claude Code row and the first Claude Code usage
rule above.

- HAR no longer turns on Claude Code's native telemetry, and removes the
  settings keys an earlier HAR wrote (only while they still hold the value HAR
  wrote). Receivers ignore native `api_request` events and `claude_code.*`
  metrics if they arrive. A hosted receiver gets OTLP from the CLI and the hook
  through its destination, like any other.
- Claude Code tokens come only from otel-hook generation spans, one per turn
  and one per subagent run; a subagent's end event carries no usage. HAR
  registers the Claude Code hook with `--claude-transcript-usage --logs
  --metrics`. Receivers keep otel-hook metrics for Claude Code.
- Codex usage comes from the session rollout, read by otel-hook only with the
  opt-in `--codex-rollout-usage`, which HAR's Codex hook must pass. Codex spans
  report cumulative totals; receivers store per-unit deltas. Usage at a Codex
  subagent's stop is not read.
- Every receiver builds the trajectory from otel-hook's OTLP log records. A
  trajectory record is keyed by (`otelhook.event.id`, content key). Its work
  identity is its own stamp, else the segment in force at its event time, else
  the attempt.
- A log record belongs to the segment in force at its event time; a span to the
  attempt in force when it **ends** (its stamp may come from either edge). A
  span is identified by (trace id, span id, start time). A resumed session run
  gets its own span id, parented to the first run's session span.
- The metrics provider is read per data point (`otelhook.provider.id` is on
  the points, not the Resource). Histogram points are kept, with their sum as
  the value and their count beside it.
- The `usage` telemetry level runs the hook too (spans and metrics, no logs):
  it is the only usage source. The CLI's transcript harvest is removed.
- The CLI 2.0 speaks only v2. `har control sync` keeps only Mission Control's
  local repository registration and live slot view, which are not part of this
  contract; the 1.x record routes (`/api/repos/<id>/…`) are gone.
- A receiver without evidence storage answers `capabilities.evidence: false`
  and `501` on the evidence endpoints.
- Telemetry before the first segment carries no work identity. A receiver that
  knows local paths (Mission Control) may place it by workspace path; a hosted
  receiver cannot, and leaves it unattributed.
- Session context files are written under a per-file exclusive lock, so two HAR
  processes cannot lose a segment. A segment's `from` and `to` are the instant
  the write was decided under the lock, and an attempt's `endedAt` is never
  earlier than any of its segments' `to`. Boundaries are as precise as that
  write (tens of milliseconds). The worktree a tool event targets keeps its own
  `vcs.ref.head.name` on log records too.
- otel-hook bounds each export (1.5 s) and treats a destination as down for
  30 s after a failure, so an unreachable receiver does not stall the agent;
  any HTTP answer counts as up.
- Upgrade: on the first 2.0 command, a machine with a hosted receiver key gets
  an `hq` destination once (recorded in `~/.har/destinations/migrations.json`,
  so a removed destination is not re-added); doctor warns when a key is set
  without an enabled `hq` destination. Mission Control migrates its database in
  place on first start, keeping the 1.x database as `<db>.v1-backup`.
- The deprecation `Link` (section 7) points at
  `https://harproject.dev/docs/guides/upgrading-to-2-0/`, a URL the docs keep
  stable. The `Deprecation` and `Sunset` dates are set when 2.0.0 ships.
- Open: an optional `FactoryRun.changedFiles` and head commit are proposed, so
  receivers can show what a verify covered; until then a v2 factory run carries
  no file list.

## Consequences

Positive:

- HQ is independent of MC (#369). A user can run MC, HQ, both, or neither.
- One contract to evolve, tested against the reference implementation.
- A factory run is one record, not three tables.
- Cost is the same number in MC and HQ, computed from tokens.
- Stage logs and artifacts reach every receiver, checkable against the proof.

Negative and costs:

- MC needs a schema migration in 2.0.
- A hosted receiver carries v1 and v2 side by side until the sunset.
- Evidence storage grows with stage output, bounded by the 1 MiB cap per stage.
- Claude Code keeps two usage sources (native and otel-hook) until
  os-factory/otel-hook#68 lands.

## Implementation plan

In order. ADR 0004 section 8 says which items fix a format.

1. **`packages/schemas`:** `ingest-v2.ts` (records, proof and evidence bodies,
   capabilities) and the session context schema.
2. **CLI:** one destination list with capabilities; #525 folded into it; HAR's
   otel-hook config as in section 6.
3. **CLI:** stage log capture with the 1 MiB tail, artifact hashing,
   `stages[].artifacts[]` in the predicate, factory line and station on the
   factory run.
4. **MC:** v2 schema and migration; v2 endpoints; latest-value metrics for
   otel-hook providers; pricing at ingest; work unit view from the joins in
   section 3.
5. **Tests:** a fixture end-to-end test that runs launch, verify and commit and
   checks that MC's work unit view returns attempts, factory runs, stages, logs,
   artifacts, proof, commit and stamped telemetry.
6. **CLI:** send to every receiver directly; remove `har control sync` to HQ.
7. **Docs:** "Where your data goes" and the 2.0 upgrade guide, including the v1
   deprecation timeline.

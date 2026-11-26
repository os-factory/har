# Local stack end to end

`run.sh` is the definition of done of HAR 2.0's decoupling (ADR 0004, ADR 0005):
the CLI built from this tree, otel-hook, Mission Control, a hosted receiver and
an OpenTelemetry Collector, run together on one machine, from a clean state.

It is not part of `har env verify`: it needs running receivers and Docker.

## What it does

Everything the CLI does runs in a sandbox under a fresh temp dir: `HOME`, the
destination list, the retry queues, the session context files and a fixture
repository with a repository URL unique to the run
(`https://example.test/har-local-stack/<run>.git`). The real `~/.har`,
`~/.claude` and Mission Control container are never touched; inside the
sandbox, `docker` only answers read-only commands.

1. Starts its own Collector (`otel/opentelemetry-collector-contrib`, pinned),
   OTLP/HTTP on a free localhost port, a file exporter per signal into the temp
   dir. The container is removed at exit.
2. Sets up the fixture (`tests/fixtures/fixture-e2e`: a harness whose verify has
   one stage writing more than 1 MiB of output and one writing an artifact),
   `har hooks install`, and the destination list: Mission Control (implicit),
   the hosted receiver (`hq` preset), the Collector (`otlp`, traces, logs and
   metrics) and `git-notes`. `har telemetry install-hooks` installs the
   otel-hook build given in `HAR_E2E_OTEL_HOOK_PACKAGE`.
3. Agent events are hook payloads replayed through the installed otel-hook
   wrapper, as Claude Code and Codex would call it, with real-looking session
   ids unique to the run, plus Claude Code's own `claude_code.api_request` log
   records sent where HAR pointed Claude Code's native telemetry
   (`~/.claude/settings.json`). No model is called.
4. The flow:
   - events from the main checkout before launch;
   - `har env launch 1 --work-id e2e-1` from the Claude Code session; the Codex
     session joins with `har env work-bind 1 --work-id e2e-1`; both work
     (prompts, tool calls, turns with usage) and a file changes;
   - `har env verify 1 --full` and `git commit`, twice (a second tree in the
     same attempt);
   - `har env complete 1` from a process with no agent session, then more events.
5. Checks every receiver through its read API, then runs the outage scenarios
   (work unit `e2e-2`) and the HAR 1.x compatibility check.

## Checks

One line per check on stdout, `PASS <check>: <detail>` or
`FAIL <check>: <detail>`; progress goes to stderr, command output to the run
log. The exit status is non-zero when any check fails. `@<receiver>` names the
receiver a line is about.

| # | Check |
|---|---|
| 1 | Commit trailers `Work-Unit`, `Factory-Run: R; trace=T`, `Factory-Attestation: sha256:D`; T = sha256("factory-run:"+R)[:32] |
| 2 | Work unit view: 1 attempt (ended), 2 factory runs, stages with statuses, session segments closed |
| 3 | Every stage log and the artifact stored, ≤ 1 MiB, the big log starting with the dropped-bytes line, bytes hashing to the proof's `stages[].artifacts[]` digests |
| 4 | Proof stored under D (its payload hashes to D), its tree = the commit tree, commit → run → proof bound |
| 5 | Agent spans: none stamped before launch, all stamped with `factory.attempt.id` inside the attempt, none after complete (receivers and Collector) |
| 6 | Verification trace T: one run span with `factory.run.id = R`, one span per stage (receivers and Collector) |
| 7 | Attempt usage per model, priced by the receiver with the genai-prices version recorded; both receivers agree on the Codex rows; Claude Code booked once, from its native telemetry |
| 8 | Mission Control down: verify and commit work, the hosted receiver gets everything, Mission Control's queue drains after restart |
| 9 | Hosted receiver down: verify and commit work, it catches up from the queues after restart, no duplicates |
| 10 | The Collector's files hold stamped spans, logs and metrics, and no `factory.local.*` key |
| 11 | With a `git-notes` destination, `git factory verify <commit> --min-level L1` passes |
| 12 | HAR 1.x (`@osfactory/har@latest`) syncs to the hosted receiver's v1 endpoint; replies carry `Deprecation`, `Sunset` and `Link` |

## Running it

```bash
npm run build
HAR_E2E_MC_URL=http://localhost:3848 \
HAR_E2E_MC_DB=<mission control>/prisma/agent_1.db \
HAR_E2E_MC_STOP='pm2 stop <app>' HAR_E2E_MC_START='pm2 start <app>' \
HAR_E2E_HOSTED_ADAPTER=/path/to/hosted-adapter \
HAR_E2E_OTEL_HOOK_PACKAGE=/path/to/osfactory-otel-hook-<version>.tgz \
tests/e2e/local-stack/run.sh
```

| Variable | Meaning |
|---|---|
| `HAR_E2E_MC_URL` | Mission Control base URL (a slot's, not the shared one) |
| `HAR_E2E_MC_DB` | Its SQLite file, for span reads (Mission Control has no span read API) |
| `HAR_E2E_MC_STOP`, `HAR_E2E_MC_START` | Shell commands that stop and start it (check 8) |
| `HAR_E2E_MC_ADAPTER` | Another Mission Control adapter (default `adapters/mission-control.sh`) |
| `HAR_E2E_HOSTED_ADAPTER` | The hosted receiver's adapter (required, see below) |
| `HAR_E2E_OTEL_HOOK_PACKAGE` | otel-hook to install (npm spec or tarball) with the session context step |
| `HAR_E2E_GIT_FACTORY` | `git-factory` executable (default: on `PATH`) |
| `HAR_E2E_HAR1_CLI` | A HAR 1.x `dist/index.js` (default: `npm install @osfactory/har@latest` into the temp dir) |
| `HAR_E2E_COLLECTOR_IMAGE` | Collector image (default `otel/opentelemetry-collector-contrib:0.139.0`) |
| `HAR_E2E_CLI` | CLI under test (default this tree's `dist/index.js`) |
| `HAR_E2E_TMPDIR` | Where the run's temp dir goes |
| `HAR_E2E_KEEP=1` | Keep the temp dir (run log, sandbox, Collector files) |
| `HAR_E2E_SETTLE_MS` | How long a check waits for a receiver to catch up (default 30000) |

## Receiver adapters

A receiver is reached through an executable adapter, so the script knows only
the ingest v2 contract and the read shapes of Mission Control's `/api/v2` reads.
A hosted receiver implements the same contract; how to authenticate a reader, a
v1 client or where its spans live is its own business, and its adapter stays
with it, outside this repository.

| Subcommand | Prints / does |
|---|---|
| `describe` | `NAME=`, `INGEST_BASE=` (the destination's ingest base URL), `READ_BASE=` (`<READ_BASE>/v2/work-units/…` and so on) |
| `setup` | Idempotent preparation (for example a reader account) |
| `ingest-key` | The ingest key (sent as `Authorization: Bearer`), empty for none |
| `read-headers` | `Name: value` lines for read requests |
| `spans trace <trace-id>` / `spans session <session-id>` | A JSON array of `{traceId, spanId, parentSpanId, name, startTime, attributes, resource}` |
| `stop`, `start` | Stop the receiver; start it and wait until it answers |
| `v1-headers` | Hosted only: `Name: value` lines a gateway in front of its v1 routes would add; `{client-bearer}` is the 1.x client's token |

The Mission Control adapter reads spans from its SQLite file: verification spans
are its factory runs and stage results.

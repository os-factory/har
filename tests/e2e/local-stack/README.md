# Local stack end to end

`run.sh` is the definition of done of HAR 2.0's decoupling (ADR 0004, ADR 0005):
the CLI built from this tree, otel-hook, Mission Control, a hosted receiver
(optional) and an OpenTelemetry Collector, run together on one machine, from a
clean state.

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
   the hosted receiver (`hq` preset, when it is configured), the Collector
   (`otlp`, traces, logs and metrics) and `git-notes`. `har telemetry
   install-hooks` installs the otel-hook build given in
   `HAR_E2E_OTEL_HOOK_PACKAGE`; the run stops unless the Claude Code hook is
   registered with `--claude-transcript-usage --logs --metrics` and no Claude
   Code native telemetry is turned on.
3. Agent events are hook payloads replayed through the installed otel-hook, as
   Claude Code and Codex would call it (each event runs the exact command HAR
   registered in `~/.claude/settings.json` or `~/.codex/hooks.json`, flags
   included; the run stops unless the Codex one carries
   `--codex-rollout-usage`), with real-looking
   session ids unique to the run. Claude Code usage comes from otel-hook only:
   it reads each turn's tokens from the transcript at `Stop`, and each
   subagent's from the subagent transcript at `SubagentStop`. Every Claude Code
   turn here runs an edit and an `Explore` subagent with a nested `Read`, so it
   has two generations on two models. Codex's `Stop` hook carries no tokens
   either: each Codex turn appends the session's running totals to a rollout
   file the hooks name as `transcript_path`, and otel-hook reads them from
   there. No model is called.
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

Without `HAR_E2E_HOSTED_ADAPTER` the hosted receiver is left out: its lines
read `SKIP` (checks 9, 12) or are not printed, and the rest runs against
Mission Control and the Collector.

## Checks

One line per check on stdout, `PASS <check>: <detail>`,
`FAIL <check>: <detail>` or `SKIP <check>: <why>`; progress goes to stderr,
command output to the run log. The exit status is non-zero when any check fails. `@<receiver>` names the
receiver a line is about.

| # | Check |
|---|---|
| 1 | Commit trailers `Work-Unit`, `Factory-Run: R; trace=T`, `Factory-Attestation: sha256:D`; T = sha256("factory-run:"+R)[:32] |
| 2 | Work unit view: 1 attempt (ended), 2 factory runs, stages with statuses, session segments closed |
| 3 | Every stage log and the artifact stored, ≤ 1 MiB, the big log starting with the dropped-bytes line, bytes hashing to the proof's `stages[].artifacts[]` digests |
| 4 | Proof stored under D (its payload hashes to D), its tree = the commit tree, commit → run → proof bound |
| 5 | Agent spans: none stamped before launch, all stamped with `factory.attempt.id` inside the attempt, none after complete (receivers and Collector). A span is placed by its end, when otel-hook emits it: the tool call that runs `har env launch` belongs to the attempt |
| 6 | Verification trace T: one run span with `factory.run.id = R`, one span per stage (receivers and Collector) |
| 7 | Attempt usage per model, priced by the receiver with the genai-prices version recorded. Claude Code from otel-hook generations only: one per turn and one per subagent run, each booked once, fresh input = input − cache read − cache write, on the turn's and the subagent's model; the Collector holds each generation span once. Both receivers agree on every row |
| 8 | Mission Control down: verify and commit work, the hosted receiver gets everything, Mission Control's queue drains after restart |
| 9 | Hosted receiver down: verify and commit work, it catches up from the queues after restart, no duplicates |
| 10 | The Collector's files hold stamped spans, logs and metrics, no `factory.local.*` key and no native Claude Code telemetry (`claude_code.*`) |
| 11 | With a `git-notes` destination, `git factory verify <commit> --min-level L1` passes |
| 12 | HAR 1.x (`@osfactory/har@latest`) syncs to the hosted receiver's v1 endpoint; replies carry `Deprecation`, `Sunset` and `Link` |
| 13 | Trajectory built from otel-hook's log records: `session.start` first when present (a receiver without local paths may not place the events before launch, which carry no work identity), every event id is stored once, no two events share a sequence, tool calls pair by call id, each subagent has a start and an end with its tool calls nested under `otelhook.subagent.id`; the Codex session has its prompts. `SKIP` for a receiver whose adapter has no `trajectory` reads |
| 14 | `--real-agents` only: the Claude Code generations otel-hook exported (Collector) hold the same tokens per model as Claude Code's own `--output-format json` report (`modelUsage`; a resumed session reports its running total) |
| 15 | otel-hook metrics: each receiver keeps a series, with its provider, of every metric the Collector got for each agent session (otel-hook names the provider on each point, not on the resource). `SKIP` for a receiver whose adapter has no `metrics` reads |

| 16 | `--upgrade-from-1x` only, once per variant (1.x trajectory forwarding off / on): the 1.x → 2.0 upgrade, see below |

## Upgrade from 1.x

`run.sh --upgrade-from-1x` runs only this scenario, and needs the hosted
receiver. Twice, in a sandbox `HOME` of its own: HAR 1.x (`@osfactory/har@1`,
or `HAR_E2E_HAR1_CLI`) initialises a fixture repository, sets telemetry to
`full` and connects to the hosted receiver with its ingest key (`har hq connect
--api-key`, portal URL = the ingest base without `/ingest`), attaching the
repository, with `--no-trajectory` and then `--trajectory`. The same `HOME`
then runs the CLI under test with no hosted-receiver variables and stdin
closed: `har hooks install`, `har telemetry install-hooks`, a launch, one
replayed Claude Code and Codex turn, a full verify, a commit, `complete`.

`16 [<variant>] local` checks that the first 2.0 command added the `hq`
destination with one notice, with logs only when 1.x forwarded the trajectory
(otel-hook's text switch is global, so logs off is what keeps text local),
printed the "full experience" hint once when it did not, never prompted, kept
the repository attached, and updated the 1.x hook commands to today's flags.
Then the hosted receiver must hold the run with its stages, logs and proof
(`records`), both receivers the session usage (check 7), Mission Control the
trajectory, and the hosted receiver the trajectory only in the forwarding
variant (check 13 there, `no-trajectory` otherwise).

## Real agents

`run.sh --real-agents` (or `HAR_E2E_REAL_AGENTS=1`) replaces the replayed
events with real sessions calling real models, in the same sandbox, with the
hooks HAR registered there (`lib/real-agents.sh`):

- Claude Code (`claude -p`, `HAR_E2E_REAL_CLAUDE_MODEL`, default `haiku`), from
  the main checkout, runs `har env launch 1 --work-id e2e-1` itself, writes the
  greeting in the slot and has an `Explore` subagent read it back;
- Codex (`codex exec`, `HAR_E2E_REAL_CODEX_MODEL`, default `gpt-5.6-luna`), when
  installed and logged in, joins in the slot with `har env work-bind`;
- the script verifies (`--full`), commits and completes as the Claude Code
  session would, then resumes that session once outside the attempt.

Only the login files are copied into the sandbox HOME (`HAR_E2E_CLAUDE_CREDENTIALS`,
default `~/.claude/.credentials.json`; `HAR_E2E_CODEX_AUTH`, default
`~/.codex/auth.json`), mode 600, and deleted as soon as the sessions end (and on
exit). Expected usage comes from what otel-hook exported, compared with the
agents' own reports (check 14). Checks 8, 9 and 12 are skipped. A run costs a
few cents (`HAR_E2E_REAL_CLAUDE_BUDGET_USD` caps each `claude -p`, default 0.40).

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
| `HAR_E2E_HOSTED_ADAPTER` | The hosted receiver's adapter (see below); unset, the hosted receiver is left out |
| `HAR_E2E_OTEL_HOOK_PACKAGE` | otel-hook to install (npm spec or tarball) with the session context step |
| `HAR_E2E_GIT_FACTORY` | `git-factory` executable (default: on `PATH`) |
| `HAR_E2E_HAR1_CLI` | A HAR 1.x `dist/index.js` (default: `npm install @osfactory/har@latest` into the temp dir; `@osfactory/har@1` for `--upgrade-from-1x`) |
| `HAR_E2E_NPM_CACHE` | `--upgrade-from-1x`: an npm cache for the sandboxes (default one per sandbox `HOME`; HAR 1.x and 2.0 each install otel-hook from it) |
| `HAR_E2E_COLLECTOR_IMAGE` | Collector image (default `otel/opentelemetry-collector-contrib:0.139.0`) |
| `HAR_E2E_CLAUDE_MODEL`, `HAR_E2E_CLAUDE_SUBAGENT_MODEL`, `HAR_E2E_CODEX_MODEL` | Models in the transcripts and turns (defaults `claude-sonnet-4-5`, `claude-haiku-4-5`, `gpt-5`) |
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
| `spans trace <trace-id>` / `spans session <session-id>` | A JSON array of `{traceId, spanId, parentSpanId, name, startTime, endTime?, attributes, resource}` |
| `trajectory session <session-id>` | Optional: a JSON array of `{eventId, eventType, sequence, attributes}`, one per stored trajectory record of the agent session. Exit 2 or 3 when the receiver has no trajectory reads (check 13 is then `SKIP`) |
| `metrics session <session-id>` | Optional: a JSON array of `{name, providerId, value, attributes}`, one per stored otel-hook metric series of the agent session. Exit 2 or 3 when the receiver has no metric reads (check 15 is then `SKIP`) |
| `stop`, `start` | Stop the receiver; start it and wait until it answers |
| `v1-headers` | Hosted only: `Name: value` lines a gateway in front of its v1 routes would add; `{client-bearer}` is the 1.x client's token |

The Mission Control adapter reads spans and the trajectory from its SQLite
file: verification spans are its factory runs and stage results.

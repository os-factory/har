---
title: Mission Control
description: Observe local repositories, worktrees, runs, validations, and artifacts.
---

Mission Control is HAR's open-source local dashboard. It combines run records and
slot state from registered repositories without replacing the repository-owned
harness.

## Start the packaged dashboard

```bash
har control up
```

The CLI pulls the Mission Control image matching its own version and starts the app
plus PostgreSQL with Docker Compose. Build the image from a source checkout instead:

```bash
har control up --build
```

Stop it with `har control down`.

## Receive OpenTelemetry (OTLP)

Mission Control is a standard OTLP receiver. Point any OpenTelemetry SDK, agent or
Collector at it, with JSON or protobuf:

| Transport | Endpoint |
|---|---|
| OTLP/gRPC | `grpc://localhost:4317` (the OTLP default) |
| OTLP/HTTP | `http://localhost:3847/api/otel` (`/v1/traces`, `/v1/metrics`, `/v1/logs`) |

```bash
# gRPC
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
# or HTTP
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3847/api/otel
```

`har control up` prints both endpoints. It publishes the gRPC port on `4317`; set
`HAR_CONTROL_OTLP_GRPC_PORT` to use another host port, or `off` to not publish it.
If the port is already taken, `up` prints a hint and starts without it: OTLP/HTTP
keeps working.

Responses follow the OTLP spec: every export is answered `200` with an
`Export*ServiceResponse` in the request's encoding. Records Mission Control cannot
attribute to a registered repository are not stored. They are counted in
`partial_success` (`rejected_spans`, `rejected_data_points`, `rejected_log_records`)
with a short `error_message`.

Mission Control stores what it receives and **forwards nothing**. HAR's own
producers fan out themselves: the agent hook and the CLI send each trace to
Mission Control and to every [destination](/docs/guides/otlp-backends/), Langfuse
or a Collector, with a retry spool per destination. Mission Control is one
destination among them, so your backends keep receiving whether it runs or not. An
SDK you point at Mission Control yourself reaches only Mission Control: point it at
your backend too, or at a Collector that fans out.

**Local paths.** Agent telemetry carries no `factory.local.*` keys (checkout and
worktree paths) by default, Mission Control included: otel-hook stamps work identity
(work unit, attempt, slot) from the session context HAR writes in `~/.har/sessions`.
Mission Control is one entry of the [destination list](/docs/reference/cli/#destinations-one-list-for-everything-har-sends);
the hook sends local paths only when every destination opts in with
`--include-local-paths`.

## Register and sync

Onboarding a repository remembers it for synchronization. You can also register
one explicitly:

```bash
har control register --repo /path/to/project
har control sync --repo /path/to/project
```

Registration and the live slot view are the only things `har control sync`
sends: they are local to Mission Control and outside the ingest contract.
Everything else — runs, work units, attempts, factory runs and stages, commit
bindings, proofs, evidence, usage and the trajectory — reaches Mission Control
like any other receiver, as ingest v2 records from the CLI and OTLP from
otel-hook (ADR 0005 section 7). Slot "last verify", History, the verification
trend, stage badges and factory lines read each factory run as a verify run, with
its stage results; the slot, occupancy and work dir of a factory run follow from its
attempt and the live slot view. Runs a 1.x CLI synced stay in a migrated database
and still display next to them. A 2.0 factory run records no list of changed files:
the diff view computes the diff from Git, from the verified tree and the head
commit its verification span reports.

Sync also runs automatically at every activity edge — login, launch, verify,
commit, complete — so registered repositories stay current without a manual
`sync` or a background watcher. `--dry-run` previews registration or sync, and
`sync --json` produces structured output.

`har control sync` asks which repositories to sync the first time it runs in a
terminal and saves the choice in `~/.har/sync-selection.json` (change it with
`har control sync --select`). Once saved, every sync — manual, automatic, and the
all-repos sync after `har control up` or `har hq connect` — touches only those
repositories. `har control
register` and attaching a repository with `har hq connect` add it to a saved
selection; an automatic sync that skips a repository outside the selection says
so on one `[har control] sync skipped` line.

An automatic sync that fails prints one `[har control] sync of <repo> failed`
line and leaves the rest for the next sync; run `har control sync` to retry and
see the details. Every request has a 30-second timeout
(`HAR_SYNC_REQUEST_TIMEOUT_MS`), and a sync that runs out of time stops sending
instead of continuing in the background.

`har control sync` sends to Mission Control only. HAR HQ does not read anything
through Mission Control: when HQ is a destination (`har telemetry destination add
hq`), the CLI and the agent hook send to it directly, whether Mission Control runs
or not.

Linked worktrees that store their own `.har/` evidence (an in-place launch inside
an external orchestrator's checkout) are included in that sync. Repository
identity stays the main checkout; the live occupancy of a slot is the active
session among those sources, so an idle report from main cannot blank a session
that is still running somewhere else. See
[Agent integrations](/docs/guides/agent-integrations/#external-worktree-managers).

## Unregister

Remove a repository from Mission Control (and stop auto-sync) from the CLI or the
repo detail page (**Unregister**):

```bash
har control unregister --repo /path/to/project
# non-interactive:
har control unregister --repo /path/to/project --yes --delete-worktrees
```

Unregister deletes synced runs/slots/telemetry for that path and records a
blocklist entry so background sync does not immediately re-add it. The CLI
proposes deleting session worktrees; confirm interactively or pass
`--delete-worktrees`. The dashboard checkbox does the same, but the packaged
Docker image often cannot see host worktree paths — use the CLI when host cleanup
is required. Re-register with `har control register`.

## Clear all data (factory reset)

To wipe the entire Mission Control database (and optionally scrub local harness
history so a later register/sync starts empty), use **Settings → Danger zone** in
the dashboard, or the CLI:

![Mission Control Settings danger zone with clear-all confirmation sheet](/assets/mission-control-reset.png)

```bash
har control reset
# non-interactive:
har control reset --yes
```

Reset deletes every repository row (runs, slots, validations, telemetry cascade)
and clears the unregister blocklist. Cloud / portal credentials are kept.
With local scrub enabled (default), it also removes `.har/runs`,
`.har/validations`, `.har/commit-bindings`, `.har/state`, and `.har/slots` under each registered
repository, and clears `~/.har/repos.json`. Packaged Docker Mission Control may
not see host paths — prefer the CLI when host scrubbing is required.
Re-register afterward with `har control register`.

## Factory: work and evidence

Factory is the default Mission Control experience. It answers four questions:

1. What durable piece of work is this?
2. Which isolated attempt executed it?
3. What ran, how long did it take, and what did the agent cost?
4. Which exact Git tree passed full verification?

![Mission Control Factory overview showing completed and active work units](/assets/factory-overview.png)

Launch with a short work identifier plus source metadata to create that evidence chain:

```bash
har env launch 1 \
  --work-id "widget-123" \
  --work-source github \
  --work-url "https://github.com/acme/widget/issues/123" \
  --work-title "Add saved filters"
```

Bind on launch when the task names a tracker issue or ticket. Use a repo-scoped
`--work-id` (not a provider-prefixed composite such as `github:owner/repo#123`);
pass the provider in `--work-source` and the canonical link in `--work-url`. Skip
binding for ad-hoc work with no tracker identity.

Every fresh launch creates an immutable attempt ID. Runs and telemetry inherit the
work and attempt correlation. Full verification produces exact-tree proof, and
`har env complete 1` records the completed outcome before teardown.

```text
External issue → Work unit → Attempt → Slot/worktree → Runs → Exact-tree validation
```

Factory derives active, failed, and verified state from that evidence. It stores
explicit state only for business outcomes such as completed or abandoned. A plain
teardown is operational cleanup and never claims success.

Historical repositories remain compatible: runs, validations, and slots without
work metadata continue to appear under Operations and repository detail. They are
not guessed into work units.

## Factory lines

Repository detail links to **Factory lines** (`/repos/<id>/lines`): a board over
the [factory lines](/docs/guides/factory-lines/) installed in that repository.
It shows stations in order, the cumulative gate and which of its stages are
green, the workstations currently in use, and the skills, MCP servers and
plugins each line declares.

The board reads the repository's own `.har/lines.json` and program — the same
source `har line status` reads — so the dashboard and the CLI always agree. It
is read-only: installing or adapting a line is `har line add` plus the
adaptation prompt that install writes, and running a gate is
`har line gate <station>`.

Line gate stages are absent from `verificationStages` by design, so the board
never lists them among verification stages. It says so on the card, and flags
the reverse case — a line stage that has leaked onto the verify plan — as an
error, matching `har env doctor`.

A repository with a harness and no line bundle gets an empty state naming the
CLI, not an install button.

## Operations: runtime and infrastructure

The repository overview summarizes registered projects, total runs, active slots,
and harness profiles. Repository detail provides:

- active slots, worktrees, branches, preview URLs, dirtiness, and drift;
- a run timeline with stage, trigger, duration, and status;
- a **History** graph of content snapshots and the commits that share them, laid out by branch. Selecting a node opens the record of the attempt that produced it: verification stages, the attempt timeline, agent trajectory and the bound work unit. Slots are live data and are not linked from the record;
- expected validation stages and their latest results;
- exact-tree content snapshots (formerly listed only as change batches) and associated commits;
- files under `.har/artifacts/`;
- verification trends and pass rates.

The global **Operations** page (`/worktrees`) lists session worktrees across
repositories (active and idle), with an **On disk** indicator, row selection,
select-all, and **Delete selected** to remove worktree directories and clear the
matching Mission Control slot rows (repository registration is kept). It also
highlights dirty/missing paths and shows **token and cost** columns when agent
telemetry is enabled (see below). Click a row for the slot leaf (LLM usage +
Verify pipeline + session timeline). Packaged Docker Mission Control may not see
host paths — use `har env teardown <id>` on the host when deletion fails. The
repository catalog lives at `/repos`; cross-repo usage rollup at `/usage`.

## Agent usage telemetry (Cursor / Claude / Codex)

HAR attributes Cursor, Claude Code, and Codex activity to each worktree/session via
[`@osfactory/otel-hook`](https://www.npmjs.com/package/@osfactory/otel-hook) and shows it in
Mission Control. Preference shape:

```json
{ "enabled": true, "level": "full", "signals": { "metrics": true, "traces": true, "logs": true, "prompts": true } }
```

You choose **how much agent activity is recorded** with one level (onboarding asks;
each level includes the ones below it):

| Level | What Mission Control gets |
|-------|---------------------------|
| `full` (default) | Prompts, agent replies, tool inputs and outputs — plus everything below |
| `outline` | The trajectory: one row per prompt, generation, tool call and subagent, with timing and outcome — no text |
| `usage` | Tokens per turn and per subagent from the agent hook, priced by Mission Control — no trajectory, no text |
| `off` | Nothing |

The `signals` in the file are derived from the level and never set on their own, so a
preference can no longer ask for prompts while disabling the hook's event records that
carry them. Install and the first `har` / MCP invocation persist the default when the
file is missing. Prompt text also fills the Mission Control **purpose** column from the
first captured user prompt.

```bash
har telemetry status                  # level + warns when the hook config disagrees with it
har telemetry on                      # full + Mission Control + @osfactory/otel-hook
har telemetry on --level outline      # every step, no text
har telemetry on --level usage        # tokens and cost only
har telemetry install-hooks           # re-run Cursor / Claude / Codex hook registration
har telemetry off                     # clear hooks OTLP export + stop MC auto-start; keeps historical rows
```

Changing the level rewrites the hook config; agent sessions already running keep the
old one, so start a new session. Override with `HAR_TELEMETRY=<level>` or `HAR_TELEMETRY=0|1`.
### Hooks never cost you a turn

Hooks fire on session start, every prompt, before and after every tool call,
and on stop — six or more times per turn. Telemetry that blocks would therefore
be paid several times over on every single turn, so the registration HAR writes
is bounded on both sides:

- Each generated hook entry carries an explicit `timeout` (10s), instead of the
  agent's much longer default.
- The wrapper caps the export itself (1.5s) and the flush (0.5s), and always
  exits 0. A dropped telemetry event must never fail a tool call.

The practical consequence: if Mission Control is not running, a turn costs a
fraction of a second per hook rather than stalling. `har telemetry status` warns
when hooks are installed and Mission Control is unreachable, and it and
`har env doctor` report what each destination has queued, for example
`mission-control: 12 batches queued, last failure 3 min ago (ECONNREFUSED)`.

Hooks config lives at `~/.har/otel-hooks/otel_config.json` (`HAR_OTEL_HOOKS_HOME` to override).
The package itself is installed under `~/.har/otel-hooks/node_modules` (pinned
`@osfactory/otel-hook`).

### Upgrading from the Python hook

Run `har telemetry install-hooks` after upgrading HAR. HAR installs the TypeScript
package in its managed hooks directory, replaces existing HAR hook registrations,
and then removes the legacy `opentelemetry-hooks` tool when it was installed with
`uv` or `pipx`. The command name remains `otel-hook`, but HAR registrations use
`~/.har/otel-hooks/run-otel-hook.sh`; the old Python executable does not need to
remain on `PATH`. Python is no longer required for HAR telemetry.

For a standalone, user-wide `otel-hook` command outside HAR, install it separately
with `npm install -g @osfactory/otel-hook`.

When telemetry is on:

1. `har env launch` auto-starts Mission Control if it is not reachable (`har control up`).
2. `har telemetry on` (and launch) install `@osfactory/otel-hook` and register Cursor / Claude / Codex hooks
   to export OTLP `http/protobuf` to `{HAR_CONTROL_API_URL}/api/otel` and to each of your
   [destinations](/docs/guides/otlp-backends/#agent-session-traces), as one destination list
   (`har telemetry status` prints it: `Agent traces: → mission-control, langfuse`).
3. Launch opens a session segment in `~/.har/sessions` for the calling agent session, and
   otel-hook stamps its work unit, attempt and slot on every record while it is in force.
   `.env.agent.<id>` keeps only `session.id`, the branch and the repository in
   `OTEL_RESOURCE_ATTRIBUTES` (no work identity). Unstamped data (an older otel-hook, a
   session that never called `har`) is still matched by workspace/cwd → slot work dir,
   then by the Resource `session.id`.
4. Token usage arrives per turn (and per subagent run) from otel-hook generation spans,
   Claude Code included: HAR turns no agent's native telemetry on, and Mission Control
   ignores Claude Code's own `api_request` events and `claude_code.*` metrics. Each
   piece is booked on the slot the agent worked in at that moment and priced with
   genai-prices; see [Usage attribution](/docs/guides/usage-attribution/).
5. The trajectory is built from otel-hook's event records (`otel/v1/logs`): one row
   per `otelhook.event.id`, in `otelhook.event.sequence` order, with a subagent's steps
   nested under its `otelhook.subagent.id`.

**Privacy:** prompt text is included by default and stays in local Mission Control (SQLite).
Record less with `har telemetry on --level outline` / `--level usage`, or nothing with
`har telemetry off`.

To send a copy to another backend, see [Send telemetry to Langfuse](/docs/guides/langfuse/)
and [Send telemetry to any OTLP backend](/docs/guides/otlp-backends/) (HAR 2.0).

### No agent content? Check the level

Prompt capture **stays on by default** — that is a product choice, not an
oversight: without it Mission Control and a hosted portal have no session content
to show, and a surface with no turns is indistinguishable from a session that had
none. Turning it off is the deliberate opt-out, and it is silent by design:

- Below `full` (`har telemetry on --level outline`, or `usage` / `off`),
  the Claude transcript harvest contributes **zero** events — and it is the only
  event harvest there is, since the Codex one covers usage alone. Anything that
  still appears is mirrored from otel spans, so turn counts read 0 for sessions
  that really had turns.
- `har telemetry status` prints the effective level and warns when the hook config
  agents read disagrees with it.
- A harvested stream longer than 1000 events keeps the most recent 1000 and marks
  the oldest surviving event with `factory.usage.harvest.truncated`,
  `factory.usage.harvest.dropped_events` and `factory.usage.harvest.total_events`, so a clipped
  session is labelled as clipped rather than looking complete.

Harvested events cover every transcript the slot owns, and fall back to the main
checkout's only when the slot has none — the same primary/fallback tier the token
harvest uses, so content and usage always describe the same session.

### Trajectory ledger

The slot **Trajectory** tab is assembled from an append-only ledger, not from the
usage/event tables. OTLP ingest and harvest write canonical facts first; event,
span, and usage rows are projections of those facts.

| Concern | Behavior |
|---|---|
| Order | Producer `sequence`, then event timestamp, then source / event id / content key. Ingestion order is not canonical. |
| Duplicates | The same `(source, sourceEventId, contentKey)` is stored once. Replayed OTLP does not create a second row. |
| Late arrival | Out-of-order facts keep their sequence. The live viewer repairs gaps after reconnect instead of appending blindly. |
| Partial content | `contentDisclosure` records `full`, `redacted`, `masked`, `truncated`, `withheld`, or `metadata_only`. Withheld and metadata-only bodies are not rendered. |
| Secrets | Attribute leaves such as `authorization` or `api_key` are stored as `[redacted]` and never used as prompt/response text. |
| Size | Bodies over `HAR_TRAJECTORY_MAX_PAYLOAD_BYTES` (default 64 KiB) are truncated. Binary tool payloads are omitted. |
| Retention | `HAR_TRAJECTORY_RETENTION_DAYS=0` (default) keeps rows. A positive value expires ledger, event, and span rows older than that. Usage totals stay. |
| Export / delete | The slot viewer can download the session as local JSONL or delete that session's trajectory. Factory reset still wipes the whole database. |
| Local vs remote | Default Mission Control is local SQLite. Export is a local download. Mission Control forwards nothing; a remote destination receives what the agent hook and the CLI send it directly. |

### Verification runs

`har env verify` posts its verification trace to Mission Control's OTLP receiver,
next to one copy per trace destination; a copy Mission Control could not take is
queued and sent once it runs (see
[How verification traces are delivered](/docs/guides/otlp-backends/#how-verification-traces-are-delivered)).
Mission Control recognizes the run span (instrumentation scope `@osfactory/har`
with `cicd.pipeline.run.id`) and stores it as a verification run with its stage
spans: run id (the validation id), tree, verdict, result, attestation digest, trace
id, work unit, attempt, branch, start and end, and each stage's result. The run span
also carries the verify policy, `factory.policy.id` and `factory.policy.digest`, as
the proof's predicate names it. The run is
attributed to its repository by the Resource `factory.local.checkout_path`, or, for
a copy the CLI queued while Mission Control was down, by `vcs.repository.url.full`
matched against the repository's git remote. A trace delivered twice is stored once.

`GET /api/repos/<id>/verification-runs` lists a repository's runs with their
stages, paged on `since` / `sinceId` like the other repository reads. There is no
dedicated page in the dashboard yet.

## Local development

Mission Control's source has its own harness:

```bash
cd control
har env launch 1
```

Use this path for development, manual testing, and screenshots. Do not run it on the
same port as the packaged `har control up` instance. Harness preflight detects the
conflict and can select another port in the slot lane.

## HAR HQ

`har hq connect` opens browser SSO (or stores `--api-key`) and attaches the current
repository to the org you pick in the portal. The CLI holds one org connection at
a time: when HQ is a destination (`har telemetry destination add hq --preset hq`), everything
the CLI and the agent hook send to HQ goes to that org only. Other locally
registered repositories are offered so you can attach them to the same org;
unattached checkouts are never ingested. Connecting to a different org replaces
the connection — nothing more is sent to the previous org, and its repositories
stop syncing until you attach them again. The connection lives in
`~/.har/portal-targets.json`; `har hq list` / `har hq disconnect` manage it. It is
never committed into `.har/`. `har control login` still works as a deprecated alias.

Attaching a repository clears a local-only opt-out left by `har control register
--no-portal`, so an attached repository is always sent. `har hq list` shows, per
repository, whether anything is sent, plus what HQ receives for agent sessions: usage
and the step outline by default, the full trajectory only when the local level is
`full` **and** forwarding is on (`har control trajectory on`, or answer yes when
`har hq connect` / `har onboard` asks).

### A slot's trajectory starts at the prompt

An agent usually reads your prompt in the main checkout and only then runs
`har env launch`. Those first steps are recorded in the main checkout (see
[Usage attribution](/docs/guides/usage-attribution/)), yet a slot's trajectory still
opens with them: it includes the session's main-checkout steps from the last prompt
before the launch, marked **Before launch · main checkout**. Records are never moved.

`har control sync --cloud` targets HAR Cloud. Hosted coordination is separate from
the local open-source dashboard and portable `.har/` contract.

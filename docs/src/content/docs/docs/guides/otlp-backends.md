---
title: Send telemetry to any OTLP backend
description: Send HAR telemetry to an OpenTelemetry Collector, Datadog or any OTLP/HTTP endpoint.
---

HAR's agent telemetry is standard OpenTelemetry, and HAR can send a copy to any
backend that speaks OTLP over HTTP: an
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/), Datadog,
Grafana, Honeycomb, or [Langfuse](/docs/guides/langfuse/). The producers send to
each destination themselves (fan-out at the producer); Mission Control is one
destination among them and forwards nothing. Nothing leaves the machine until you
add a destination.

## Add a destination

Turn telemetry on first (`har telemetry on`), then:

```bash
har telemetry destination add collector --preset otlp \
  --endpoint http://collector.internal:4318
har telemetry destination test collector
```

- `--endpoint` is the base OTLP/HTTP URL. Each signal goes to
  `<endpoint>/v1/traces`, `/v1/logs` or `/v1/metrics`.
- `--header Name=value` adds a request header, for an API key or a tenant. Repeat it
  for several headers. Put credentials in a header, never in the URL.
- `--signals` picks what the destination receives. The default is
  `traces,metrics`. Logs are opt-in: pass `--signals traces,metrics,logs` to add
  them. At the `full` level logs carry prompts, replies and tool input/output
  verbatim, so `add` prints a warning when you subscribe to them.
- `--include-local-paths` keeps the attributes that hold absolute local paths. By
  default they are stripped, except `factory.local.*` in agent traces while Mission
  Control is a destination (see [Privacy](#privacy)).
- `--include-account-identity` keeps the attributes that identify your account
  (`user.email`, `user.account_uuid`, `user.id`, `organization.id`, …) in what the
  CLI sends. By default they are stripped.
- `--disabled` stores the destination without sending to it. `--overwrite`
  replaces a destination with the same name.

A backend that needs an API key:

```bash
har telemetry destination add vendor --preset otlp \
  --endpoint https://otlp.example.com \
  --header "Authorization=Bearer $OTLP_TOKEN" \
  --signals traces
```

Manage destinations:

```bash
har telemetry destination list          # the agent route, header values masked, local paths and account identity stripped or included
har telemetry destination test vendor   # one OTLP/JSON test record, prints the HTTP status
har telemetry destination remove vendor
```

Destinations live in `~/.har/destinations/telemetry.json`, mode `0600`, because
header values are secrets. They are machine-wide: every repository's sessions go to
the same destinations.

## What each signal carries

| Signal | Source | Content |
|---|---|---|
| `traces` | `@osfactory/otel-hook` (`outline`, `full`) | One span per session, prompt, generation and tool call, with `gen_ai.*` attributes. No text at any level |
| `traces` | `har env verify` (every level except `off`) | One run span and one child span per stage, with `cicd.pipeline.*` and `factory.*` attributes. Ids, results and timings only |
| `logs` (opt-in) | otel-hook event records (`outline`, `full`) | At `full`, prompts, agent replies and tool inputs and outputs (see [Privacy](#privacy)). At `outline`, metadata only |
| `metrics` | none | Nothing is sent to destinations. Claude Code's native metrics and `claude_code.api_request` log events carry account identity and go to Mission Control only |

Verification traces follow the telemetry profile's
[verification spans](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md#verification-spans).
The trace id is `sha256("factory-run:" + run id)`, first 32 hex characters, where the
run id is the validation id (`Factory-Run`, `predicate.run.id`). Details are in the
[CLI reference](/docs/reference/cli/#har-telemetry). How they travel is in
[How verification traces are delivered](#how-verification-traces-are-delivered).

## Example: OpenTelemetry Collector

A Collector that receives OTLP/HTTP from HAR and prints what it gets:

```yaml
# otelcol.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

```bash
docker run --rm -p 4318:4318 -v "$PWD/otelcol.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector-contrib:latest --config /etc/otelcol/config.yaml
```

Replace `debug` with your real exporter. Add an
[`attributes` or `transform` processor](https://opentelemetry.io/docs/collector/configuration/#processors)
to drop anything else you don't want to keep, for example the `factory.local.*`
keys that agent traces carry while Mission Control is a destination
([#519](https://github.com/os-factory/har/issues/519)).

The agent hook and the CLI run on your machine, so a Collector on the same machine
is reached at `http://localhost:4318`, the same URL `destination test` uses.

## How telemetry reaches a destination

HAR fans out at the producer. Each producer sends to Mission Control and to every
destination itself, and keeps its own retry spool per receiver. Mission Control
stores what it receives (see
[Receive OpenTelemetry](/docs/guides/mission-control/#receive-opentelemetry-otlp))
and forwards nothing, so a destination does not depend on Mission Control running.
`har telemetry status` prints the route:

```text
Agent traces:  → mission-control, collector
  mission-control  traces http://localhost:3847/api/otel/v1/traces, logs http://localhost:3847/api/otel/v1/logs
  collector        traces http://collector.internal:4318/v1/traces
Verification traces: → mission-control, collector
Destination health:
  mission-control: healthy, nothing queued
  collector: healthy, nothing queued
```

### Agent session traces

HAR writes one destination list into the hook config
(`~/.har/otel-hooks/otel_config.json`) as otel-hook's `exporter.destinations[]`:

- `mission-control`, when Mission Control is enabled and set up (a container, or a
  custom `HAR_CONTROL_API_URL`): traces to `/api/otel/v1/traces` and, from the
  `outline` level, logs to `/api/otel/v1/logs`, with no headers;
- every enabled destination subscribed to `traces` or `logs`, with only the signals
  it subscribes to.

otel-hook sends each batch to every entry in parallel, and whatever one entry could
not take waits in that entry's own spool for the next hook event, so a slow or
failing destination never blocks the others or the agent.

- **Secrets stay out of the config.** Every header value there is an `env:`
  reference, such as `"Authorization": "env:HAR_OTEL_DIRECT_HEADER_1_1"`. The values
  themselves are only in `~/.har/otel-hooks/direct.env` (mode `0600`), which the hook
  wrapper loads at run time. No secret is on a command line, in the wrapper or in
  the hook config.
- **One Resource for every entry.** One hook process sends the same Resource to all
  of them. Mission Control needs `factory.local.*` to attribute sessions, so while
  it is in the list every destination receives those keys
  ([#519](https://github.com/os-factory/har/issues/519)). Without Mission Control,
  `factory.local.*` stays out of the agent's Resource unless **every** destination
  has `--include-local-paths`. otel-hook itself sends hashed workspace ids, not paths.
- **Claude Code's own telemetry is not in the list.** Its native metrics and logs
  carry account identity: they go to Mission Control only, and stay off without it.
- **otel-hook 0.9.0 or later.** HAR installs it on `har env launch` and
  `har telemetry on`. With an older copy, HAR sends agent traces to Mission Control
  only and says which version it needs.
- **Re-routing.** `destination add|remove`, `har control up|down` and
  `har telemetry on|off` rewrite the list; hooks pick it up on their next event.

Since otel-hook 0.9.0, the retry spool behaves like this:

- A full spool drops its **oldest** batches first (default bounds: 16 MiB, 72 hours
  and 500 batches per destination). Every drop is counted by reason.
- A batch rejected with a non-retryable status (for example `400` or `401`) is
  dropped, not spooled. Only `408`, `429`, `500`, `502`, `503` and `504` are retried,
  so a bad request does not block the queue behind it.
- Hook events that close no span (such as Claude Code `SessionStart`) send no
  request.

### How verification traces are delivered

Each `har env verify` builds one verification trace and delivers it exactly once to
each receiver:

- The CLI sends one copy to Mission Control and one to every enabled destination
  subscribed to `traces`, in parallel, as OTLP/JSON, about 3 seconds each.
  Mission Control's copy keeps `factory.local.checkout_path` so it can attribute the
  run, stores it as a verification run and includes it in the next HQ sync. Each
  destination's copy is stripped of the denied attributes.
- A copy that was not taken (Mission Control not running, a destination down) is
  queued in `~/.har/spool/traces` for that receiver alone. A queued copy is deleted
  as soon as it is accepted, and no receiver is ever sent another receiver's copy.

The spool keeps one file per payload and receiver (mode 0600), no header values
(they are read from the destination file at send time), `factory.local.*` and the
other denied attributes stripped before writing, and caps of 64 MB, 24 hours and 8
attempts. Removing or disabling a destination drops its queued copies. It is
flushed at the start of the next `har env verify` or `har env launch`, with a
2-second budget, and on demand:

```bash
har telemetry destination flush
```

Delivery never changes verify's result. With telemetry `off`, no trace is built.

### Destination health

`har env doctor` and `har telemetry status` report what each receiver has queued:
the agent hook's spools, read with `otel-hook doctor --json` from the hooks home, and
the CLI's verification spool. A destination with queued batches, drops in the last
24 hours, or a failure in the last hour is a warning:

```text
⚠ telemetry destinations
    warn  langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)
```

Header values are never printed, only the names of header variables that are
missing. The check reads local files only and never fails the doctor: without
otel-hook installed it is skipped with a note.

### Without Mission Control

When Mission Control is disabled (`HAR_CONTROL_DISABLED=true`) or not set up, the
list has no `mission-control` entry and everything above still applies:

```bash
export HAR_CONTROL_DISABLED=true
har telemetry status          # Agent traces:  → collector
```

## Correlation attributes

HAR follows the Factory Commits
[telemetry profile](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md).
These resource attributes are set on every agent session HAR launches and on every
verification trace, so any backend can group sessions and runs by work unit,
attempt, repository and branch. The values
are the same ones HAR writes into [Factory Commits proofs](/docs/guides/factory-commits/).

| Attribute | Value |
|---|---|
| `factory.work_unit.id` | The work unit bound at launch (`--work-id`) |
| `factory.work_unit.source` | Its tracker, e.g. `github`, `linear` |
| `factory.attempt.id` | The attempt the slot belongs to |
| `vcs.repository.url.full` | The `origin` remote URL, credentials stripped |
| `vcs.ref.head.name` | The slot's branch |
| `factory.producer.name` | `har` |
| `factory.producer.version` | The HAR version |

Agent sessions also carry, on their Resource:

| Attribute | Value |
|---|---|
| `session.id` | The HAR session key (the slot's branch, or `agent-<id>-…`) |
| `factory.slot.id` | The slot number |
| `factory.local.checkout_path` | Absolute path of the main checkout (local-only) |
| `factory.local.work_dir` | Absolute path of the slot's work dir (local-only) |

Verification run spans add `factory.run.id`, `factory.git.tree`, `factory.verdict`
(on `--full`) and `cicd.pipeline.*`. These match the `Factory-Run` trailer and the
proof's tree. Session spans carry the OpenTelemetry GenAI attributes (`gen_ai.request.model`,
`gen_ai.usage.*`, `gen_ai.tool.name`, `gen_ai.conversation.id`) and `session.id`
(the HAR session key).

HAR 2.0 removed the 1.x `har.*` attributes; the
[upgrade guide](/docs/guides/upgrading-to-2-0/#removed-telemetry-attributes) maps
each one to its new name. `factory.local.*` is a local-only namespace: destinations
receive its keys with `--include-local-paths`, and in agent traces while Mission
Control is a destination ([#519](https://github.com/os-factory/har/issues/519)).

An unknown value is left out, never sent empty. A slot launched without
`--work-id` has no work unit attributes.

## Privacy

With the default settings, no prompt, reply or tool text and no account identity
leaves the machine, and no absolute local path does unless Mission Control is one
of the agent route's destinations:

- **Logs are opt-in.** Only logs can carry text, and `--preset otlp` subscribes to
  `traces` and `metrics` unless you name `logs` in `--signals`. The Langfuse preset
  never subscribes to logs.
- **Local paths.** These attributes hold absolute local paths: every
  `factory.local.*` key, `gen_ai.client.workspace`,
  `gen_ai.client.repository_root`, `cwd`, `process.cwd`,
  `process.executable.path`, `process.command`, `process.command_line`,
  `process.command_args`, `code.filepath` and `code.file.path`. The CLI strips them
  from every verification copy it sends a destination or writes to its spool. Agent
  traces carry one Resource for every receiver: while Mission Control is in the
  list they keep the `factory.local.*` keys it needs for attribution, so your
  destinations receive them too. That is a known trade-off, tracked in
  [#519](https://github.com/os-factory/har/issues/519). Without Mission Control,
  HAR leaves them out unless every destination has `--include-local-paths`. A
  destination added with `--include-local-paths` receives them in every case.
- **Account identity stays in Mission Control.** Claude Code attaches your email,
  account and organization ids to its own metrics and events, and those go to
  Mission Control only. In anything the CLI sends a destination, these attributes
  are stripped: `user.email`, `user.account_uuid`, `user.account_id`, `user.id`,
  `user.groups`, `organization.id`, `user.name`, `user.full_name`, `user.hash`,
  `user.roles`, `enduser.id`, `enduser.pseudo.id`, `enduser.role` and
  `enduser.scope`. A destination added with `--include-account-identity` keeps them.

Mission Control's local redaction and size limits apply to what it stores. A
destination receives what the producers send it.

What each signal carries once it reaches a destination:

- **Verification traces** carry ids, results and timings only: no commands or logs.
  Their Resource `factory.local.checkout_path` is for Mission Control's attribution
  and is stripped from every copy sent to a destination or written to a spool,
  unless the destination opted in with `--include-local-paths`.
- **Session traces** carry no prompt, reply or tool text at any level. They do carry
  model names, token counts, tool names, branch names and HAR's resource attributes
  (work unit, attempt, repository URL, branch, HAR version, slot number), plus the
  `factory.local.*` paths while Mission Control is a destination.
- **Logs**, if you subscribe to them, carry otel-hook's event records: at the `full`
  level your prompts, the agent's replies and tool inputs and outputs **verbatim,
  without secret redaction**, truncated by otel-hook (1,024 characters per piece by
  default). At `outline` they carry the kind, length and a hash of each piece, never
  the text.
- **Metrics**: nothing. Claude Code's token and cost counters stay in Mission
  Control.

To send less:

- leave `logs` out of `--signals` (the default) to keep text out of a destination at
  every level;
- `har telemetry on --level outline` stops recording text for Mission Control and every
  destination;
- `--disabled` or `har telemetry destination remove <name>` stops sending to it.

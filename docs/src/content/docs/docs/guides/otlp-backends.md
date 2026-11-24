---
title: Send telemetry to any OTLP backend
description: Forward HAR telemetry to an OpenTelemetry Collector, Datadog or any OTLP/HTTP endpoint.
---

HAR's agent telemetry is standard OpenTelemetry. Mission Control receives it
locally and can forward a copy to any backend that speaks OTLP over HTTP: an
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/), Datadog,
Grafana, Honeycomb, or [Langfuse](/docs/guides/langfuse/). Nothing leaves the
machine until you add a destination.

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
  default Mission Control strips them (see [Privacy](#privacy)).
- `--include-account-identity` keeps the attributes that identify your account
  (`user.email`, `user.account_uuid`, `user.id`, `organization.id`, …). By default
  Mission Control strips them too.
- `--disabled` stores the destination without forwarding to it. `--overwrite`
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
har telemetry destination list          # header values masked, local paths and account identity stripped or included
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
| `logs` (opt-in) | Claude Code `claude_code.api_request` events (`usage` and up) | Model, tokens, cost and duration per request. No prompt text: HAR never sets `OTEL_LOG_USER_PROMPTS` |
| `metrics` | Claude Code native metrics (`usage` and up) | Token and cost counters |

Verification traces follow the telemetry profile's
[verification spans](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md#verification-spans).
The trace id is derived from the validation id. Details are in the
[CLI reference](/docs/reference/cli/#har-telemetry). How they travel is in
[How verification traces are delivered](#how-verification-traces-are-delivered).

## Example: OpenTelemetry Collector

A Collector that receives OTLP/HTTP from Mission Control and prints what it gets:

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
to drop anything else you don't want to keep. Local paths and account identity are
already stripped unless you added the destination with `--include-local-paths` or
`--include-account-identity`.

:::caution[Mission Control runs in Docker]
Mission Control forwards from inside its container, where `localhost` is the
container itself. `destination test` runs from your terminal, so it can pass against
`http://localhost:4318` while forwarding fails. For a Collector on the same machine,
use `http://host.docker.internal:4318`, with the Collector listening on `0.0.0.0`.
Docker Desktop resolves that name, and on Linux `har control up` adds it to the
container (`--add-host=host.docker.internal:host-gateway`). A container started by an
older HAR lacks it: run `har control down`, then `har control up`.
:::

## How forwarding works

Agent session telemetry goes through Mission Control, which receives OTLP on
`grpc://localhost:4317` and `http://localhost:3847/api/otel` (see
[Receive OpenTelemetry](/docs/guides/mission-control/#receive-opentelemetry-otlp)).
Anything that exports OTLP can send there and be forwarded with HAR's own sessions:

- **OTLP as received, minus local paths and account identity.** Each receiver
  (`/api/otel/v1/traces`, `/logs`, `/metrics`, and the gRPC `Export` services) first stores the data for Mission
  Control. Then it forwards the request, with its content type and encoding, to
  every enabled destination subscribed to that signal. Before a copy is spooled,
  Mission Control removes the attributes that hold absolute local paths or identify
  your account (see [Privacy](#privacy)). A body that
  has none is forwarded byte for byte. One that has some is decoded, filtered and
  re-encoded in the same format and encoding. A body that may hold one but cannot be
  decoded is not forwarded. Data received over gRPC is forwarded as OTLP/HTTP
  protobuf. Forwarding never changes the receiver's response, so a
  slow or failing destination never slows an agent down.
- **Durable spool.** Each copy is written to a spool on Mission Control's data
  volume before it is sent, so a queued copy is kept across a Mission Control
  restart.
- **Retry.** Timeouts, HTTP 408, 429 and 5xx are retried with exponential backoff
  (up to 5 minutes between attempts, 8 attempts). Other 4xx responses are dropped at
  once. Copies older than 24 hours are dropped, and the spool is capped at 64 MiB,
  oldest first.
- **Secrets never spooled.** The spool holds the body and its content type. Header
  values are read from the destination file at send time and never written to the
  spool.
- **Withdrawal wins.** Removing or disabling a destination, unsubscribing a signal,
  or turning `--include-local-paths` or `--include-account-identity` back off drops
  its queued copies.

### How verification traces are delivered

Each `har env verify` builds one verification trace and delivers it once to each
receiver:

- **Mission Control running.** The CLI posts the trace to Mission Control's OTLP
  receiver (`/api/otel/v1/traces`) and sends nothing directly. Mission Control
  stores it as a verification run, includes it in the next HQ sync, and forwards it
  to your destinations with the spool, privacy filter and retries described above.
- **Mission Control not running.** The CLI sends the trace as OTLP/JSON to every
  enabled destination subscribed to `traces`, in parallel, about 3 seconds each. A
  copy that fails is queued in a small spool under `~/.har/spool/traces`, with a
  copy for Mission Control. That copy is marked "store, do not forward", so your
  destinations don't receive the trace twice.

The spool follows the same rules as Mission Control's: one file per payload (mode
0600), no header values (they are read from the destination file at send time),
`factory.local.*` and the other denied attributes stripped before writing, and caps
of 64 MB and 24 hours. It is flushed at the start of the next `har env verify` or
`har env launch`, with a 2-second budget, and on demand:

```bash
har telemetry destination flush
```

Delivery never changes verify's result. With telemetry `off`, no trace is built.

For session telemetry, Mission Control must be running with `~/.har/destinations` mounted. `har telemetry
on` and `har env launch` start it. If `destination add` says the running container
predates destinations, run `har control up` to recreate it. Mission Control re-reads
the destination file when it changes, so adding or removing a destination needs no
restart.

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
receive its keys only with `--include-local-paths`.

An unknown value is left out, never sent empty. A slot launched without
`--work-id` has no work unit attributes.

## Privacy

With the default settings, no absolute local path, no account identity and no
prompt, reply or tool text leaves the machine:

- **Logs are opt-in.** Only logs can carry text, and `--preset otlp` subscribes to
  `traces` and `metrics` unless you name `logs` in `--signals`. The Langfuse preset
  never forwards logs.
- **Local paths are stripped.** Mission Control keeps them locally for attribution,
  but removes these attributes from every forwarded copy, at resource, scope, span,
  span event, span link, log record, metric data point and exemplar level, before
  the copy is spooled:
  every `factory.local.*` key, `gen_ai.client.workspace`,
  `gen_ai.client.repository_root`, `cwd`, `process.cwd`,
  `process.executable.path`, `process.command`, `process.command_line`,
  `process.command_args`, `code.filepath` and `code.file.path`. A destination added
  with `--include-local-paths` receives them.
- **Account identity is stripped.** Claude Code attaches your email, account and
  organization ids to its own metrics and events. Mission Control keeps them locally
  and removes these attributes, at the same levels, from every forwarded copy:
  `user.email`, `user.account_uuid`, `user.account_id`, `user.id`, `user.groups`,
  `organization.id`, `user.name`, `user.full_name`, `user.hash`, `user.roles`,
  `enduser.id`, `enduser.pseudo.id`, `enduser.role` and `enduser.scope`. A
  destination added with `--include-account-identity` receives them, for example to
  group usage by person in your own backend.

Apart from that, a destination receives what Mission Control's receivers get for
its signals. Mission Control's local redaction and size limits apply to what it
stores, not to what it forwards.

What each signal carries once it reaches a destination:

- **Verification traces** carry ids, results and timings only: no commands or logs.
  Their Resource `factory.local.checkout_path` is for Mission Control's attribution
  and is stripped from every copy sent to a destination or written to a spool,
  unless the destination opted in with `--include-local-paths` (Mission Control path
  only; the CLI's direct path always strips it).
- **Session traces** carry no prompt, reply or tool text at any level. They do carry
  model names, token counts, tool names, branch names and HAR's resource attributes
  (work unit, attempt, repository URL, branch, HAR version, slot number).
- **Metrics** are Claude Code's token and cost counters, with Claude Code's standard
  attributes minus account identity: session id, terminal type and, if you enabled
  them in Claude Code, app version and entrypoint.
- **Logs**, if you subscribe to them, carry at the `full` level your prompts, the
  agent's replies and tool inputs and outputs **verbatim, without secret
  redaction**, truncated by otel-hook (1,024 characters per piece by default). At
  `outline` they carry the kind, length and a hash of each piece, never the text.
  Claude Code's own log events carry token and cost data and the same session id
  as its metrics, without account identity.

To send less:

- leave `logs` out of `--signals` (the default) to keep text out of a destination at
  every level;
- `--signals traces` also leaves out Claude Code's metrics and their session ids;
- `har telemetry on --level outline` stops recording text for Mission Control and every
  destination;
- `--disabled` or `har telemetry destination remove <name>` stops forwarding.

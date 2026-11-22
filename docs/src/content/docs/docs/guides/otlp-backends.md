---
title: Send telemetry to any OTLP backend
description: Forward HAR telemetry to an OpenTelemetry Collector, Datadog or any OTLP/HTTP endpoint.
---

:::note[2.0 (in development)]
Telemetry destinations are part of HAR 2.0, which is not released yet. The
commands below exist on the 2.0 development branches only.
:::

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
- `--signals traces,logs,metrics` narrows what the destination receives. The
  default is all three.
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
har telemetry destination list          # header values are masked
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
| `logs` | otel-hook event records (`outline`, `full`) | At `full`, prompts, agent replies and tool inputs and outputs (see [Privacy](#privacy)). At `outline`, metadata only |
| `logs` | Claude Code `claude_code.api_request` events (`usage` and up) | Model, tokens, cost and duration per request. No prompt text: HAR never sets `OTEL_LOG_USER_PROMPTS` |
| `metrics` | Claude Code native metrics (`usage` and up) | Token and cost counters |

Verification runs (`har env verify`) are not emitted as spans yet. They will be
added in a later 2.0 change, following the profile's verification spans.

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
to drop what you don't want to keep, for example `har.repo_path` and `har.work_dir`.

:::caution[Mission Control runs in Docker]
Mission Control forwards from inside its container, where `localhost` is the
container itself. `destination test` runs from your terminal, so it can pass against
`http://localhost:4318` while forwarding fails. For a Collector on the same machine,
use an address the container can reach: `http://host.docker.internal:4318` on
Docker Desktop, or the Docker bridge address (usually `http://172.17.0.1:4318`) on
Linux, with the Collector listening on `0.0.0.0`.
:::

## How forwarding works

- **Raw OTLP.** Each receiver (`/api/otel/v1/traces`, `/logs`, `/metrics`) first
  stores the data for Mission Control. Then it forwards the request body unchanged,
  with its content type and encoding, to every enabled destination subscribed to that
  signal. Forwarding never changes the receiver's response, so a slow or failing
  destination never slows an agent down.
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
- **Withdrawal wins.** Removing or disabling a destination, or unsubscribing a
  signal, drops its queued copies.

Mission Control must be running with `~/.har/destinations` mounted. `har telemetry
on` and `har env launch` start it. If `destination add` says the running container
predates destinations, run `har control up` to recreate it. Mission Control re-reads
the destination file when it changes, so adding or removing a destination needs no
restart.

## Correlation attributes

HAR follows the Factory Commits
[telemetry profile](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md).
These resource attributes are set on every agent session HAR launches, so any
backend can group sessions by work unit, attempt, repository and branch. The values
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

Spans also carry the OpenTelemetry GenAI attributes (`gen_ai.request.model`,
`gen_ai.usage.*`, `gen_ai.tool.name`, `gen_ai.conversation.id`) and `session.id`
(the HAR session key).

HAR still emits its older `har.*` attributes with the same values, for
compatibility: `har.work_unit_id`, `har.attempt_id`, `har.branch`,
`har.session_key`, `har.agent_id`, `har.repo_path` and `har.work_dir`. New queries
should use the `factory.*` and `vcs.*` names.

An unknown value is left out, never sent empty. A slot launched without
`--work-id` has no work unit attributes.

## Privacy

A destination receives exactly what Mission Control's receivers get for its
signals. Mission Control's local redaction and size limits apply to what it stores,
not to what it forwards.

- **Traces** carry no prompt, reply or tool text at any level. They do carry model
  names, token counts, tool names, branch names and HAR's resource attributes,
  including the local paths in `har.repo_path` and `har.work_dir`.
- **Logs** at the `full` level carry your prompts, the agent's replies and tool
  inputs and outputs **verbatim, without secret redaction**, truncated by otel-hook
  (1,024 characters per piece by default). At `outline` they carry the kind, length
  and a hash of each piece, never the text.
- **Claude Code's own logs and metrics** carry token and cost data, plus Claude
  Code's standard attributes (session and account identifiers, which can include
  your account email).

To send less:

- `--signals traces` keeps text out of a destination at every level;
- `har telemetry on --level outline` stops recording text for Mission Control and every
  destination;
- `--disabled` or `har telemetry destination remove <name>` stops forwarding.

---
title: Send telemetry to Langfuse
description: Send HAR agent session traces to Langfuse Cloud or a self-hosted Langfuse.
---

HAR can send a copy of its agent telemetry to [Langfuse](https://langfuse.com).
The producers send it themselves: the agent hook sends each session's traces to
Mission Control and to Langfuse, and the CLI does the same for each verification
trace. Mission Control is one destination among them and forwards nothing. Nothing
leaves the machine until you add a destination.

## What you get

- **Agent session traces.** One trace per Cursor, Claude Code or Codex session,
  with one span per prompt, model generation and tool call. Spans use the OpenTelemetry
  GenAI attributes: `gen_ai.operation.name`, `gen_ai.request.model`,
  `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
  `gen_ai.tool.name` and the cache token counts.
- **Correlation.** Every trace carries the slot's work unit and attempt
  (`factory.work_unit.id`, `factory.attempt.id`), the repository URL and the branch.
  Filter on them to see every session that worked on one issue. The full list is in
  [Send telemetry to any OTLP backend](/docs/guides/otlp-backends/#correlation-attributes).
- **Verification runs.** Each `har env verify` sends one trace: a run span with the
  verdict and verified tree (`factory.run.id`, `factory.git.tree`, `factory.verdict`
  on `--full`) and one child span per stage. They carry the same work unit, attempt,
  repository and branch, so they sit next to the agent sessions that produced the
  change. See [verification spans](/docs/reference/cli/#har-telemetry) in the CLI
  reference.

Session traces come from `@osfactory/otel-hook`, which HAR installs at every
telemetry level except `off`: it is the only source of agent usage. Verification
traces are sent at every level except `off`.

Claude Code (2.1.128 and later) removes every `OTEL_*` variable from the hooks it
runs, so the session profile cannot reach otel-hook as `OTEL_RESOURCE_ATTRIBUTES`.
HAR also writes it to `.env.agent.<id>` as `HAR_RESOURCE_ATTRIBUTES`, and the hook
wrapper restores it. Start the agent from a shell that loaded the slot's env file,
or session spans in Langfuse lack `session.id` and the `factory.*` attributes.

## Set it up

1. Turn telemetry on. This starts Mission Control and installs the agent hooks:

   ```bash
   har telemetry on                     # level full (default)
   har telemetry on --level outline     # spans with timing, no text kept locally
   ```

2. Export your Langfuse project keys (Langfuse → Project settings → API keys):

   ```bash
   export LANGFUSE_PUBLIC_KEY=pk-lf-...
   export LANGFUSE_SECRET_KEY=sk-lf-...
   # US region or self-hosted only (default https://cloud.langfuse.com):
   export LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
   ```

3. Add the destination and test it:

   ```bash
   har telemetry destination add langfuse --preset langfuse
   har telemetry destination test langfuse
   ```

   `add` reads the keys from the environment and stores the destination in
   HAR's destination list, `~/.har/destinations/destinations.json` (mode `0600`). You can pass
   `--public-key`, `--secret-key` and `--host` instead of the environment
   variables. `test` sends one small test span from your terminal and prints
   Langfuse's HTTP status.

4. Start a new agent session. Running sessions keep the hook config they started with.

## How the traces get there

HAR fans out at the producer. `har telemetry status` shows the route:

```text
Agent traces:  → mission-control, langfuse
  mission-control  traces http://localhost:3847/api/otel/v1/traces, logs http://localhost:3847/api/otel/v1/logs
  langfuse         traces https://cloud.langfuse.com/api/public/otel/v1/traces
Verification traces: → mission-control, langfuse
```

- **Agent session traces.** HAR gives otel-hook one destination list
  (`exporter.destinations[]`): `mission-control` when its entry is enabled and
  Mission Control is set up, plus every other enabled destination with an OTLP signal.
  otel-hook sends each batch to every entry in parallel, and whatever one entry
  could not take waits in that entry's own spool for the next hook event. Langfuse
  gets its copy whether or not Mission Control is running.
- **Verification traces.** The CLI sends one copy to Mission Control and one to
  Langfuse. A copy that was not taken is queued for that receiver alone and retried
  at the next verify or launch (or `har telemetry destination flush`), so Langfuse
  receives each verification trace exactly once. See
  [How verification traces are delivered](/docs/guides/otlp-backends/#how-verification-traces-are-delivered).
- **Mission Control** stores what it receives. It does not forward, and it does not
  need to be running for Langfuse to receive anything.

`destination add` and `remove`, `har control up` and `down`, and `har telemetry on`
and `off` each rewrite the route. Hooks pick it up on their next event.

What to know about the route:

- **Keys stay off command lines.** The `Authorization` header is written to
  `~/.har/otel-hooks/direct.env` (mode `0600`), which the hook wrapper loads when it
  runs. The hook config names Langfuse with an `env:` reference to that file; the
  wrapper script, the hook config and the hook's arguments contain no secret.
- **No local paths.** One hook process sends the same Resource to every entry, and
  HAR leaves `factory.local.*` out of it unless every destination, Mission Control
  included, has `--include-local-paths`. See [Privacy](#privacy-what-leaves-the-machine).
- **Claude Code's own telemetry stays local.** Claude Code's native metrics and logs
  carry your account identity, so they go to Mission Control only, and stay off
  without it. Without Mission Control, Claude Code token and cost metrics are not
  recorded.
- **otel-hook 0.14.0.** HAR installs it on `har env launch` and
  `har telemetry on`. With a copy older than 0.9.0, HAR prints the version it needs
  and sends agent traces to Mission Control only.
- **Retries and health.** A full spool drops its oldest batches, and a batch Langfuse
  rejects with a non-retryable status (such as `401` for a wrong key) is dropped
  rather than retried. `har env doctor` and `har telemetry status` report what is
  queued per destination, for example
  `langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)`.

### Without Mission Control

If you don't run Mission Control (`HAR_CONTROL_DISABLED=true`, or no Docker), the
list simply has no `mission-control` entry:

```bash
export HAR_CONTROL_DISABLED=true
har telemetry on --level outline
har telemetry destination add langfuse --preset langfuse
har telemetry status          # Agent traces:  → langfuse
```

## Langfuse limits

- **Traces only.** Langfuse ingests OTLP traces, not logs or metrics, so the preset
  subscribes to `traces` and refuses any other `--signals`.
- **HTTP only.** Langfuse's endpoint is `<host>/api/public/otel` over OTLP/HTTP.
  There is no gRPC option.

## Privacy: what leaves the machine

Langfuse receives two kinds of spans. Agent session spans come straight from
otel-hook, and otel-hook puts **no prompt, reply or tool text on spans at any
level**. Verification spans come straight from the CLI and carry ids, results and
timings only: no commands or logs. Their one local path,
`factory.local.checkout_path`, is stripped from Langfuse's copy. The text that `full` records travels in OTLP log
records, which the Langfuse preset never subscribes to.

A session span can contain:

- the agent name and version, model names, token counts, timing and outcome;
- tool names (`Bash`, `Edit`, …) and tool call ids;
- session and conversation ids;
- the branch name of the worktree a tool touched, and opaque, hashed workspace and
  repository ids;
- HAR's attributes: repository URL (credentials stripped), branch and HAR version,
  plus, while the session works in a slot, the work unit id and source, attempt id
  and slot number, which otel-hook stamps from the session context HAR writes.

**Local paths.** HAR leaves every `factory.local.*` key out of the agent's
`OTEL_RESOURCE_ATTRIBUTES`, and the hook drops any it inherits, unless every
destination, Mission Control included, has `--include-local-paths`.
A verification span's `factory.local.checkout_path` is always removed from
Langfuse's copy unless Langfuse has `--include-local-paths`.

Your account identity (`user.email`, `user.account_uuid`, `user.id`,
`organization.id`, …) is carried by Claude Code's native telemetry, which HAR does
not turn on.

The telemetry level changes what Langfuse receives only at the edges: `usage`,
`outline` and `full` send the same spans, and `off` sends none. To send less:

- `har telemetry destination add langfuse --preset langfuse --disabled --overwrite`
  keeps the destination but stops sending to it;
- `har telemetry destination remove langfuse` deletes it;
- `har telemetry on --level usage` stops session spans for every destination and for
  Mission Control; `har telemetry off` stops verification spans too.

To send the local paths in every case, for example to a self-hosted Langfuse on your
own network, add the destination with `--include-local-paths`. To send account
identity attributes that a span or a verification copy carries, add
`--include-account-identity`. The two opt-ins are independent:

```bash
har telemetry destination add langfuse --preset langfuse --include-local-paths --overwrite
har telemetry destination add langfuse --preset langfuse --include-account-identity --overwrite
```

`har telemetry destination list` shows whether a destination's local paths and
account identity are stripped or included. The full list of stripped attributes is in
[Send telemetry to any OTLP backend](/docs/guides/otlp-backends/#privacy).

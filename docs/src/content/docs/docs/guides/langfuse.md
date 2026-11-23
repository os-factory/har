---
title: Send telemetry to Langfuse
description: Forward HAR agent session traces to Langfuse Cloud or a self-hosted Langfuse.
---

HAR can send a copy of its agent telemetry to [Langfuse](https://langfuse.com).
Mission Control receives the telemetry locally, as it does today, and forwards the
traces to Langfuse. Nothing leaves the machine until you add a destination.

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

Session traces come from `@osfactory/otel-hook`, which HAR installs at the `outline`
and `full` telemetry levels. At `usage` there are no session traces. Verification
traces are sent at every level except `off`.

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
   `~/.har/destinations/telemetry.json` (mode `0600`). You can pass
   `--public-key`, `--secret-key` and `--host` instead of the environment
   variables. `test` sends one small test span from your terminal and prints
   Langfuse's HTTP status.

4. Start a new agent session. Running sessions keep the hook config they started with.

## When to run `har control up`

Mission Control forwards the agent session traces, so it must be running and able
to read `~/.har/destinations`. Verification traces go straight from the CLI to
Langfuse and don't need Mission Control. `har telemetry on` and `har env launch` start it when it is
not running. Run `har control up` yourself when:

- `destination add` prints that the running container predates destinations. A
  Mission Control container started by an older HAR does not mount the directory, and
  `har control up` recreates it.
- Mission Control is stopped and you want forwarding to resume.

You don't need to restart Mission Control after adding, changing or removing a
destination. It re-reads the file when it changes.

## Langfuse limits

- **Traces only.** Langfuse ingests OTLP traces, not logs or metrics, so the preset
  subscribes to `traces` and refuses any other `--signals`.
- **HTTP only.** Langfuse's endpoint is `<host>/api/public/otel` over OTLP/HTTP.
  There is no gRPC option.

## Privacy: what leaves the machine

Langfuse receives two kinds of spans. Agent session spans come from otel-hook
through Mission Control, and otel-hook puts **no prompt, reply or tool text on spans
at any level**. Verification spans come from the CLI and carry ids, results and
timings only: no commands, logs or local paths. The text that `full` records travels in OTLP log records,
which the Langfuse preset never forwards.

A session span can contain:

- the agent name and version, model names, token counts, timing and outcome;
- tool names (`Bash`, `Edit`, …) and tool call ids;
- session and conversation ids;
- the branch name of the worktree a tool touched, and opaque, hashed workspace and
  repository ids;
- HAR's resource attributes: work unit id and source, attempt id, repository URL
  (credentials stripped), branch, HAR version and slot number.

A session span never reaches Langfuse with absolute local paths or your account
identity. Mission Control keeps them for its own attribution, but it removes every
attribute that holds a local path (every `factory.local.*` key, `process.cwd`,
`code.filepath`, …) or identifies your account (`user.email`, `user.account_uuid`,
`user.id`, `organization.id`, …) before it spools or sends a copy. Verification
spans never carry them.

The telemetry level changes what Langfuse receives only at the edges: `outline` and
`full` send the same spans, `usage` sends verification spans only, and `off` sends
none. To send less:

- `har telemetry destination add langfuse --preset langfuse --disabled --overwrite`
  keeps the destination but stops forwarding;
- `har telemetry destination remove langfuse` deletes it;
- `har telemetry on --level usage` stops session spans for every destination and for
  Mission Control; `har telemetry off` stops verification spans too.

To send the local paths anyway, for example to a self-hosted Langfuse on your own
network, add the destination with `--include-local-paths`. To send account identity,
for example to see sessions per person, add `--include-account-identity`. The two
opt-ins are independent:

```bash
har telemetry destination add langfuse --preset langfuse --include-local-paths --overwrite
har telemetry destination add langfuse --preset langfuse --include-account-identity --overwrite
```

`har telemetry destination list` shows whether a destination's local paths and
account identity are stripped or included. The full list of stripped attributes is in
[Send telemetry to any OTLP backend](/docs/guides/otlp-backends/#privacy).

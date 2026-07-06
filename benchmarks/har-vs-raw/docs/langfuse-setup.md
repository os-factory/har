# Langfuse + Claude Code telemetry for the benchmark

Copy `.env.local.example` to `.env.local` after Langfuse is running:

```bash
cp .env.local.example .env.local
# edit keys
```

## Local Langfuse

```bash
./scripts/setup-langfuse.sh
```

Default UI: `http://localhost:3300` (change `LANGFUSE_PORT` if needed).

## Claude Code telemetry

The benchmark runner exports these before each Claude Code session:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_TRACES_EXPORTER=otlp
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export CLAUDE_CODE_OTEL_DIAG_STDERR=1
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT="$LANGFUSE_HOST/api/public/otel"
export OTEL_EXPORTER_OTLP_HEADERS="$(python3 scripts/lib/common.py)"  # see run_task.py
```

For richer transcript/tool-call traces, also install the Langfuse Claude Code plugin:

```bash
claude plugin marketplace add langfuse/Claude-Observability-Plugin
claude plugin install langfuse-observability@langfuse-observability
```

Per-session metadata tags (`repo`, `issue`, `arm`, `run_id`) are attached by `run_task.py`.

#!/usr/bin/env bash
# Receiver adapter for Mission Control (see README.md, "Receiver adapters").
#
# Env: HAR_E2E_MC_URL    Mission Control base URL (required), e.g. http://localhost:3848
#      HAR_E2E_MC_DB     its SQLite database, for span reads (MC has no span read API)
#      HAR_E2E_MC_STOP   shell command that stops it      (checks 8)
#      HAR_E2E_MC_START  shell command that starts it     (checks 8; this adapter waits until it answers)
set -euo pipefail

URL="${HAR_E2E_MC_URL:?HAR_E2E_MC_URL is not set}"
URL="${URL%/}"

sql_json() {
  [ -n "${HAR_E2E_MC_DB:-}" ] || { echo "HAR_E2E_MC_DB is not set: no span reads" >&2; exit 3; }
  sqlite3 -readonly -json "$HAR_E2E_MC_DB" "$1"
}

case "${1:-}" in
  describe)
    echo "NAME=mission-control"
    echo "INGEST_BASE=$URL/api"
    echo "READ_BASE=$URL/api"
    ;;
  ingest-key | read-headers | setup) ;;
  spans)
    field=$2 value=${3//\'/}
    case "$field" in
      trace)
        # Mission Control keeps verification spans as the factory run (run span)
        # and its stage results (stage spans).
        rows=$(sql_json "select traceId, spanId, null as parentSpanId, pipelineName as name, startedAt as startTime,
            json_object('factory.run.id', factoryRunId) as attributes, '{}' as resource
          from FactoryRun where traceId = '$value' and spanId is not null
          union all
          select s.traceId, s.spanId, r.spanId, s.stageId, s.startTime,
            json_object('cicd.pipeline.task.name', s.stageId), '{}'
          from StageResult s join FactoryRun r on r.factoryRunId = s.factoryRunId
          where s.traceId = '$value' and s.spanId is not null")
        ;;
      session)
        rows=$(sql_json "select traceId, spanId, parentSpanId, name, startTime, attributes, '{}' as resource
          from AgentSessionSpan where sessionId = '$value'")
        ;;
      *) echo "spans: trace|session" >&2; exit 2 ;;
    esac
    # SQLite gives epoch millis and JSON text: normalise to the adapter shape.
    node -e '
      const rows = JSON.parse(process.argv[1] || "[]");
      const json = (v) => (typeof v === "string" ? JSON.parse(v || "{}") : v ?? {});
      const iso = (v) => (typeof v === "number" ? new Date(v).toISOString() : /^\d+$/.test(String(v)) ? new Date(Number(v)).toISOString() : v);
      console.log(JSON.stringify(rows.map((r) => ({ ...r, startTime: iso(r.startTime), attributes: json(r.attributes), resource: json(r.resource) }))));
    ' "$rows"
    ;;
  stop)
    [ -n "${HAR_E2E_MC_STOP:-}" ] || { echo "HAR_E2E_MC_STOP is not set" >&2; exit 3; }
    bash -c "$HAR_E2E_MC_STOP" >/dev/null
    ;;
  start)
    [ -n "${HAR_E2E_MC_START:-}" ] || { echo "HAR_E2E_MC_START is not set" >&2; exit 3; }
    bash -c "$HAR_E2E_MC_START" >/dev/null
    for _ in $(seq 1 120); do
      curl -sf "$URL/api/v2/capabilities" >/dev/null 2>&1 && exit 0
      sleep 1
    done
    echo "Mission Control did not come back at $URL" >&2
    exit 1
    ;;
  *) echo "usage: $0 describe|ingest-key|setup|read-headers|spans|stop|start" >&2; exit 2 ;;
esac

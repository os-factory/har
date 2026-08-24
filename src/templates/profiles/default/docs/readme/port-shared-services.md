## Port & shared services

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| App — frontend | Per slot | `HARNESS_FE_BASE_PORT + (AGENT_ID × HARNESS_PORT_STEP)` | Scan `STEP` increments within the slot lane |
| App — API | Per slot | `HARNESS_API_BASE_PORT + (AGENT_ID × STEP)` | Same scan policy |
| Node debug | Per slot | `9200 + (AGENT_ID × STEP)` | Same scan policy |
| Shared Postgres | Per machine | `HARNESS_DB_PORT_DEFAULT` | Scan `HARNESS_DB_PORT_SCAN_START..END` |
| MinIO / S3 | Per machine | `HARNESS_MINIO_PORT_DEFAULT` (+ console port) | Scan configured ranges in `harness.env` |
| Mailpit | Per machine | `HARNESS_MAILPIT_*_PORT_DEFAULT` | Scan configured ranges |
| Headless browser | Per machine | `HARNESS_BROWSER_PORT_DEFAULT` | Scan configured ranges |

Resolved ports may differ from the formula when something else is already bound. Always use `./.har/agent-cli.sh <id>` or read `.har/slots/agent-<id>.json` — never hardcode `3010`, `15432`, etc. in app code or tests.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| Postgres | One shared container; per-slot database `agent_<id>` cloned from template | `HARNESS_INFRA_SERVICES="db"` |
| MinIO / S3 | One shared container; per-slot bucket `agent-<id>` | `HARNESS_INFRA_SERVICES="... minio"` |
| Mailpit, Redis, etc. | One shared container on a scanned host port | Listed in `HARNESS_INFRA_SERVICES` |
| Primary application | One PM2 ecosystem per slot (isolated ports) | `HARNESS_PRIMARY_APP`, `ecosystem.agent.template.cjs` |
| Internal supporting services | Shared across all slots | `docker-compose.agent.yml` or `ecosystem.shared.config.cjs` |

Shared infra starts once via `./.har/setup-infra.sh` (also run automatically by `launch.sh`). Per-slot databases are cloned in `launch.sh`.

### Do not

- Hardcode default ports (`3000`, `15432`, `3847`, …) in application code, tests, or agent docs — read from `.env.agent.<id>`, `agent-cli.sh`, or the slot registry
- Run raw `docker compose` for harness infrastructure — use `setup-infra.sh` / `launch.sh` so ports are scanned and persisted in `.har/state/infra.env`

### Primary app vs shared services

Each slot runs **only the primary application** (`HARNESS_PRIMARY_APP` in `harness.env`) — the app agents modify. Everything else runs **once**, shared by all slots on fixed ports:

- **External dependencies** (Postgres, Redis, mail, ...): services in `docker-compose.agent.yml`, enabled via the `HARNESS_INFRA_SERVICES` list in `harness.env`, started by `setup-infra.sh`.
- **Internal supporting services** (other services of a monolith/monorepo the agent depends on but does not change): either compose services in `docker-compose.agent.yml`, or PM2 processes in an optional `.har/ecosystem.shared.config.cjs` (named `har-shared-<name>`, started by `setup-infra.sh`).

Isolation still applies where it matters: each slot gets its own database (`agent_<id>`, cloned from the template DB), ports, and git worktree.

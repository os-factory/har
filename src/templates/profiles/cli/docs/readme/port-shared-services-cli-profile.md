## Port & shared services (CLI profile)

This profile has **no PM2 app ports** — agents run project commands directly in their worktree. Port variables in `harness.env` exist for optional test servers and for shared Docker infra.

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Shared Postgres | Per machine | `HARNESS_DB_PORT_DEFAULT` | Scan `HARNESS_DB_PORT_SCAN_START..END` |
| Other compose services | Per machine | `HARNESS_*_PORT_DEFAULT` for that service | Scan configured ranges in `harness.env` |

When a repo adds a local HTTP server for integration tests, prefer reading ports from `.env.agent.<id>` or `./.har/agent-cli.sh <id>` rather than hardcoding values.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| Postgres / Redis / mail / … | One shared container on a scanned host port | `HARNESS_INFRA_SERVICES` + matching vars in `harness.env` |
| Per-slot databases | Cloned from template DB when `db` is enabled | `launch.sh` |
| Application code | Isolated git worktree per slot | `HARNESS_USE_WORKTREE=true` |

### Do not

- Hardcode `15432` or other default infra ports in tests — read `AGENT_DB_PORT` from `.env.agent.<id>` or `har_pg`
- Run raw `docker compose` for harness infrastructure — use `setup-infra.sh`

## Port & shared services (iOS profile)

Pure iOS apps have **no per-slot TCP ports** — agents build and run on a shared iOS Simulator. Optional backend containers (mock API, etc.) use the same shared-infra model as other profiles.

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Optional backend (compose) | Per machine | `HARNESS_*_PORT_DEFAULT` for that service | Scan configured ranges in `harness.env` |
| iOS Simulator | Per slot | One device created per agent — no harness port | None: `har-<project>-agent-<id>-<model>` is unique per slot |

When your app talks to a local backend, read the resolved host port from `.env.agent.<id>` (set by `setup-infra.sh`) — never hardcode `15432` or similar in tests or flow scripts.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| iOS Simulator | One device created per slot, deleted at teardown | `HARNESS_SIMULATOR_*`, `launch.sh` |
| Optional backend | One shared compose service | `HARNESS_INFRA_SERVICES` (e.g. `"mock-server"`) |
| Application code | Isolated git worktree per slot | `HARNESS_USE_WORKTREE=true` |

### Do not

- Hardcode backend ports in RocketSim flows or unit tests — read from agent env
- Run raw `docker compose` for harness infrastructure — use `setup-infra.sh`

## Readiness layers

Do not treat a health endpoint as the whole definition of success. Adapt this
section for the repository:

| Layer | What it means | Where to encode it |
|-------|---------------|--------------------|
| Infra ready | Shared services and template data stores exist | `setup-infra.sh`, `docker-compose.agent.yml` |
| Slot data ready | Every per-slot data store is created/cloned | `launch.sh` |
| Process ready | Primary app is running and health passes | `launch.sh`, `verify.sh` |
| Agent usable | Login/API/UI smoke works with documented data | `HARNESS_READINESS_CMD`, browser-e2e, `CLAUDE.agent.md` |

If full local-dev setup is too heavy to run in the harness, document the skipped
steps and add the minimum substitute directly in `.har/` scripts (for example an
idempotent bootstrap for required users/tenants/settings). Health alone is not
enough for UI/auth apps.

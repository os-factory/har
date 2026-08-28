## Readiness layers

Do not treat a health endpoint as the whole definition of success. Adapt this
section for the repository:

| Layer | What it means | Where to encode it |
|-------|---------------|--------------------|
| Infra ready | Shared services and template data stores exist | `har env setup-infra`, `docker-compose.agent.yml` |
| Slot data ready | Every per-slot data store is created/cloned | `har env launch` |
| Process ready | Primary app is running and health passes | `har env launch`, `har env verify` |
| Agent usable | Login/API/UI smoke works with documented data | `HARNESS_READINESS_CMD`, browser-e2e, `.har/README.md` |

If full local-dev setup is too heavy to run in the harness, document the skipped
steps and add the minimum substitute directly in `.har/` scripts (for example an
idempotent bootstrap for required users/tenants/settings). Health alone is not
enough for UI/auth apps.

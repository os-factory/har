# Agent ${AGENT_ID} — Development Environment

> See also [`AGENT.md`](../AGENT.md) at the repo root and [`.har/README.md`](./README.md) for the full harness guide.

## Your Environment

- **Agent ID**: ${AGENT_ID}
- **Frontend URL**: http://localhost:${FE_PORT}
- **API URL**: http://localhost:${API_PORT}
- **Database**: `agent_${AGENT_ID}` on `localhost:${DB_PORT}

## Managing Your Stack

Always use `agent-cli.sh` to interact with your stack:

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs api
./.har/agent-cli.sh ${AGENT_ID} restart api
./.har/agent-cli.sh ${AGENT_ID} health
./.har/agent-cli.sh ${AGENT_ID} psql "SELECT 1"
./.har/agent-cli.sh ${AGENT_ID} url
```

## Verification Workflow

Run verification **after every change**:

```bash
# Quick verification (stops on first failure)
./.har/verify.sh ${AGENT_ID}

# Full verification (runs all steps)
./.har/verify.sh ${AGENT_ID} --full
```

## Definition of Done

Your task is done when ALL of these are true:
- [ ] `./.har/verify.sh ${AGENT_ID} --full` returns `"status": "pass"`
- [ ] The feature/fix works correctly in the browser or API
- [ ] Tests cover the change
- [ ] No type errors, no lint warnings
- [ ] Changes are committed with a clear message

## What NOT To Do

- **Do NOT** hardcode ports — your services use agent-specific ports
- **Do NOT** run raw `docker compose` commands — use `setup-infra.sh`
- **Do NOT** modify shared infrastructure containers
- **Do NOT** touch other agents' databases or PM2 processes
- **Do NOT** edit `.env.agent.${AGENT_ID}` or `ecosystem.agent.${AGENT_ID}.config.cjs` manually

## Project Commands

```bash
# TODO: Add project-specific commands here
# Examples:
# npm run dev
# npm test
# npm run typecheck
```

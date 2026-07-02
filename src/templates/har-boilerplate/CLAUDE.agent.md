# Agent ${AGENT_ID} — Development Environment

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Frontend** | http://localhost:${FE_PORT} |
| **API** | http://localhost:${API_PORT} |
| **Database** | `agent_${AGENT_ID}` on `localhost:${DB_PORT}` (when Postgres infra is enabled) |

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs api
./.har/agent-cli.sh ${AGENT_ID} health
```

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] When `stages/browser-e2e.sh` exists, full verify includes Playwright — adapt specs under `tests/` for UI changes
- [ ] New behavior has automated test coverage (unit and/or browser as appropriate)
- [ ] Changes committed with a clear message

Quick loop during development: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}` (stops before lint and browser-e2e).

## Project commands

```bash
# TODO: adapt for this repository (see package.json, Makefile, etc.)
# npm run typecheck
# npm test
# npm run lint
```

## Do not

- Hand-roll docker/dev-server startup — `launch` is how you run the app (manual testing, browser, screenshots included)
- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Hardcode ports — use agent env / `agent-cli.sh url`
- Run raw `docker compose` for shared harness infra — use `setup-infra.sh`
- Edit `.env.agent.${AGENT_ID}` or PM2 ecosystem files by hand
- Run `verify` before `launch` when health or e2e steps need a running server

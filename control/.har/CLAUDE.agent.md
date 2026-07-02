# Agent ${AGENT_ID} — Mission Control

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **App URL** | http://localhost:${FE_PORT} |
| **Health** | http://localhost:${FE_PORT}/api/health |
| **Database** | `postgresql://har:har@localhost:5433/har_control` (start: `docker compose up -d db`) |
| **Work dir** | Git worktree when enabled — commit from there |

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs web
./.har/agent-cli.sh ${AGENT_ID} health
```

## Definition of done

A task is complete only when:

- [ ] `./.har/verify.sh ${AGENT_ID} --full` returns `"status": "pass"` (includes Playwright `browser-e2e`)
- [ ] New or changed UI behavior has coverage in `tests/` (unit and/or Playwright as appropriate)
- [ ] Changes are committed with a clear message

Quick check during development: `./.har/verify.sh ${AGENT_ID}` (stops before lint/e2e).

## Project commands (in work dir)

```bash
npm run typecheck
npm test
npm run lint
npm run test:e2e          # Playwright only
```

## Do not

- Hand-roll docker/dev-server startup — `launch` is how you run the app (manual testing, browser, screenshots included)
- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Hardcode ports — use agent env / `agent-cli.sh url`
- Edit `.env.agent.${AGENT_ID}` or PM2 ecosystem files by hand
- Skip `launch` before `verify` (server must be running for health and e2e)

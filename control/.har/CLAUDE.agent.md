# Agent ${AGENT_ID} — Mission Control

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **App URL** | http://localhost:${FE_PORT} |
| **Health** | http://localhost:${FE_PORT}/api/health |
| **Database** | `agent_${AGENT_ID}` on `localhost:15432` — per-slot clone of `template_control` (harness-managed) |
| **Work dir** | Fresh session worktree per launch — see the launch output or `control/.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Edits there hot-reload in the running slot (`next dev`); use `./.har/agent-cli.sh ${AGENT_ID} restart web` if a change doesn't take. Relaunching replaces the session (branch kept); a dirty previous session is refused unless `--force`.

This slot runs **only the primary application** (`HARNESS_PRIMARY_APP=web`, the Next.js app). Shared infrastructure (Postgres) runs once for all slots — `setup-infra.sh` manages it; never start it yourself.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs web
./.har/agent-cli.sh ${AGENT_ID} health
```

## Definition of done

A task is complete only when:

- [ ] `./.har/verify.sh ${AGENT_ID} --full` returns `"status": "pass"` (includes Playwright `browser-e2e`)
- [ ] New or changed UI behavior has coverage in `tests/` (unit and/or Playwright as appropriate)
- [ ] Changes are committed **in the session worktree** with a clear message
- [ ] The user got the app URL (http://localhost:${FE_PORT}) to test themselves
- [ ] Finish with `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — records the validation and tears down while **keeping the session branch** for the user to push / open a PR

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
- Run raw `docker compose` for shared harness infra — use `setup-infra.sh`
- Edit `.env.agent.${AGENT_ID}` or PM2 ecosystem files by hand
- Skip `launch` before `verify` (server must be running for health and e2e)
- Edit the main checkout — all edits go under the session work dir

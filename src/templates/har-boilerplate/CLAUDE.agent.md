# Agent ${AGENT_ID} — Development Environment

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Frontend** | http://localhost:${FE_PORT} |
| **API** | http://localhost:${API_PORT} |
| **Database** | `agent_${AGENT_ID}` on `localhost:${DB_PORT}` (when `db` is in `HARNESS_INFRA_SERVICES`) |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Edits there hot-reload in the running slot; use `./.har/agent-cli.sh ${AGENT_ID} restart` if a change doesn't take. Relaunching replaces the session (branch kept) and requires explicit confirmation; dirty worktrees also need `--force` after user approval.

This slot runs **only the primary application** (`HARNESS_PRIMARY_APP`). External dependencies and any supporting services run once, shared by all slots — `setup-infra.sh` manages them; never start them yourself.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs api
./.har/agent-cli.sh ${AGENT_ID} health
```

## Readiness

Adapt this section for the repository. A passing health check means the process
is alive; it does not automatically mean an agent can use the app.

- **Health**: `./.har/agent-cli.sh ${AGENT_ID} health`
- **Agent-usable smoke**: document the login/API/UI workflow agents should try,
  or wire it into `HARNESS_READINESS_CMD` / full verify.
- **Credentials/default data**: document any test users, tenants, projects, or
  settings created by the harness.
- **Skipped full-dev setup**: document anything intentionally omitted from the
  upstream developer setup and the minimal substitute in `.har/`.

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] The slot is agent-usable for this repo's documented smoke workflow, not only health-check green
- [ ] When `stages/browser-e2e.sh` exists, full verify includes Playwright — adapt specs under `tests/` for UI changes
- [ ] New behavior has automated test coverage (unit and/or browser as appropriate)
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] The user got the preview URLs to test the app themselves
- [ ] Finish with `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — records the validation and tears down while **keeping the session branch** for the user to push / open a PR

Quick loop during development: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}` (stops before lint and browser-e2e).

## Project commands

```bash
# TODO: adapt for this repository (see package.json, Makefile, pyproject.toml, CI, etc.)
# npm run typecheck
# pytest -q
# go test ./...
# cargo test
# make test
```

## Do not

- Hand-roll docker/dev-server startup — `launch` is how you run the app (manual testing, browser, screenshots included)
- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Hardcode ports — use agent env / `agent-cli.sh url`
- Run raw `docker compose` for shared harness infra — use `setup-infra.sh`
- Start other services of the repo in your slot — only the primary app runs per-slot; shared services are already running
- Edit `.env.agent.${AGENT_ID}` or PM2 ecosystem files by hand
- Run `verify` before `launch` when health or e2e steps need a running server
- Edit the main checkout — all edits go under the session work dir

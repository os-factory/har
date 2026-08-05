# Agent ${AGENT_ID} — Mission Control

> [`AGENTS.md`](../AGENTS.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **App URL** | http://localhost:${FE_PORT} |
| **Health** | http://localhost:${FE_PORT}/api/health |
| **Database** | SQLite `prisma/agent_${AGENT_ID}.db` in the session work dir (created by `prisma db push` at launch) |
| **Work dir** | Fresh session worktree per launch — see the launch output or `control/.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Edits there hot-reload in the running slot (`next dev`); use `./.har/agent-cli.sh ${AGENT_ID} restart web` if a change doesn't take. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

This slot runs **only the primary application** (`HARNESS_PRIMARY_APP=web`, the Next.js app). Mission Control uses **embedded SQLite** per slot — no shared Postgres (`HARNESS_INFRA_SERVICES` is empty).

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs web
./.har/agent-cli.sh ${AGENT_ID} health
```

## Definition of done

A task is complete only when:

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] The app is agent-usable for the documented smoke workflow, not only health-check green
- [ ] When `stages/browser-e2e.sh` exists, full verify includes Playwright — adapt specs under `tests/` for UI changes
- [ ] New or changed UI behavior has coverage in `tests/` (unit and/or Playwright as appropriate)
- [ ] Changes are committed **in the session worktree** with a clear message
- [ ] The user got the app URL (http://localhost:${FE_PORT}) to test themselves
- [ ] Present session handoff (summary, branch, preview URLs) and **wait for user** before `complete`, push, or PR
- [ ] On user approval of the default: push + open PR (when `gh`/GitHub MCP available), then `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — full verify + validation + teardown, branch kept

### Session handoff

After full verify and commit, stop and propose next steps. Never autonomously run
`complete`, `teardown`, `git push`, or open a PR. **Default recommendation:** when
`gh` or GitHub MCP is available, complete the slot **and** open a PR (push → PR →
`har env complete` / `har_complete_environment`). Offer complete-only or something
else as alternatives. If PR tooling is unavailable, recommend complete and report
the session branch for a manual push. Prefer `complete` over bare `teardown` when
the work succeeded. See `.cursor/rules/har-workflow.mdc` for the handoff shape.

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

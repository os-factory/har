# Agent ${AGENT_ID} — @osfactory/har Development

> [`AGENTS.md`](../AGENTS.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Fresh session worktree per launch — see launch output or `.har/slots/agent-${AGENT_ID}.json` |
| **Infra** | None for this repo (`HARNESS_INFRA_SERVICES` is empty) |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} url
```

## Readiness

This CLI harness has **no runtime server** — agents validate through static analysis and tests. Full verify is sufficient for agent-usable checks today; no `HARNESS_READINESS_CMD` is configured.

For Mission Control (Next.js + Postgres), use `control/.har/` instead.

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] Full verify runs every registered stage in `stages.json` `verificationStages` (`docs-drift`)
- [ ] New behavior has automated test coverage
- [ ] Changes committed **in the session worktree** with a clear message
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

Quick loop: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}`

Stages are the harness's single vocabulary for checks — interact through the registry (`har_run_stage`, `verify`), not stack-specific tooling. Authoring guide: `.har/STAGES.md`.

## Project commands

Run in the session work dir (or via `agent-cli.sh exec`):

```bash
./.har/agent-cli.sh ${AGENT_ID} exec npm test
./.har/agent-cli.sh ${AGENT_ID} exec npm run typecheck
./.har/agent-cli.sh ${AGENT_ID} exec npm run build
./.har/agent-cli.sh ${AGENT_ID} exec npm run check --prefix docs
./.har/agent-cli.sh ${AGENT_ID} exec npm run drift --prefix docs
```

Harness control-plane commands (MCP / `har env`) target the main repo checkout; project commands run in your work dir.

After changing `src/templates/`: `npm run build`, then test with a linked `har` install or `har env init --force --profile cli` on a fixture.

## Do not

- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.${AGENT_ID}` by hand
- Edit the main checkout — all edits go under the session work dir
- Run ad-hoc `npm test` from the repo root — use MCP/`har env verify` or `agent-cli.sh exec`

## Architecture notes

See `AGENTS.md` for layer boundaries (`cli/` → `core/` → `harness/`). Put template changes in `src/templates/` and run `npm run build` before testing a linked `har` install.

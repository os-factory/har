# Agent ${AGENT_ID} — @har/cli Development

> See also [`AGENT.md`](../AGENT.md) and [`.har/README.md`](./README.md).

## Your Environment

- **Agent ID**: ${AGENT_ID}
- **Work dir**: git worktree at `~/worktrees/har_project-agent-${AGENT_ID}` (default)
- **Infra**: none for this repo (`HARNESS_INFRA_*` all false)

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} url
```

## Working in your worktree

```bash
./.har/agent-cli.sh ${AGENT_ID} exec npm test
./.har/agent-cli.sh ${AGENT_ID} exec npm run typecheck
./.har/agent-cli.sh ${AGENT_ID} exec npm run build
```

Harness scripts (`.har/*`) always run from the main repo checkout; project commands run in your work dir.

## Verification

```bash
./.har/verify.sh ${AGENT_ID}          # typecheck + unit tests
./.har/verify.sh ${AGENT_ID} --full   # + lint + build — required before done
```

## Definition of Done

- [ ] `./.har/verify.sh ${AGENT_ID} --full` returns `"status": "pass"`
- [ ] Tests cover the change
- [ ] No type errors, no lint warnings
- [ ] Changes committed in your worktree with a clear message

## What NOT To Do

- **Do NOT** edit the main checkout while your worktree is active — work in the slot work dir
- **Do NOT** run ad-hoc `npm test` from the repo root — use `./.har/verify.sh` or `agent-cli.sh exec`
- **Do NOT** edit `.env.agent.${AGENT_ID}` manually

## Architecture notes

See `AGENT.md` for layer boundaries (`cli/` → `core/` → `harness/`). Put template changes in `src/templates/` and run `npm run build` before testing a linked `har` install.

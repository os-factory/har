# Agent ${AGENT_ID} — Development Environment

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Git worktree when `HARNESS_USE_WORKTREE=true` |

```bash
./.har/agent-cli.sh ${AGENT_ID} status
```

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] When `stages/browser-e2e.sh` exists, full verify includes Playwright — adapt specs under `tests/` for UI changes
- [ ] New behavior has automated test coverage
- [ ] Changes committed with a clear message

Quick loop: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}`

## Project commands

```bash
# TODO: adapt for this repository
# npm run typecheck
# npm test
```

## Do not

- Edit `.env.agent.${AGENT_ID}` by hand
- Run `verify` before `launch` when e2e needs a running server

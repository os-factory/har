# Agent ${AGENT_ID} — Development Environment

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Relaunching replaces the session (branch kept); a dirty previous session is refused unless `--force`.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
```

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] When `stages/browser-e2e.sh` exists, full verify includes Playwright — adapt specs under `tests/` for UI changes
- [ ] New behavior has automated test coverage
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] Finish with `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — records the validation and tears down while **keeping the session branch** for the user to push / open a PR

Quick loop: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}`

## Project commands

```bash
# TODO: adapt for this repository
# npm run typecheck
# npm test
```

## Do not

- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.${AGENT_ID}` by hand
- Run `verify` before `launch` when e2e needs a running server
- Edit the main checkout — all edits go under the session work dir

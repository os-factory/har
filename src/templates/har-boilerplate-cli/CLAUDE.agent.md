# Agent ${AGENT_ID} — Development Environment

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Relaunching replaces the session (branch kept) and requires explicit confirmation (`--replace` / `confirmReplace`); dirty worktrees also need `--force` after user approval — never autonomously.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
```

## Readiness

Adapt this section for the repository. For pure CLI/library repos, full verify
may be enough. If the project needs services, auth, seeded data, or a sample
workflow, document the required credentials/default data and wire a smoke into
`HARNESS_READINESS_CMD` or full verify.

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] The slot is agent-usable for this repo's documented smoke workflow when runtime services are involved
- [ ] Full verify runs every registered stage in `stages.json` `verificationStages` (Playwright, custom checks, …) — when `stages/browser-e2e.sh` exists, adapt specs under `tests/` for UI changes
- [ ] New behavior has automated test coverage
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] Finish with `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — records the validation and tears down while **keeping the session branch** for the user to push / open a PR

Quick loop: MCP `har_run_verification`, `har env verify ${AGENT_ID}`, or `./.har/verify.sh ${AGENT_ID}`

Stages are the harness's single vocabulary for checks: templates and custom stages compile to generic kinds in `.har/stages.json`, and you interact with them only through the registry (`har_run_stage`, `verify`), never stack-specific tooling. Authoring guide: `.har/STAGES.md`.

## Project commands

```bash
# TODO: adapt for this repository. Examples:
# npm test
# pytest -q
# go test ./...
# cargo test
# make test
```

## Do not

- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.${AGENT_ID}` by hand
- Run `verify` before `launch` when e2e needs a running server
- Edit the main checkout — all edits go under the session work dir

# Agent ${AGENT_ID} — @osfactory/har Development

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Cursor IDE

If `.cursor/rules/har-workflow.mdc` exists, the harness workflow is injected into every Cursor agent session automatically.
Run `har env maintain` to refresh it.

## Your Environment

- **Agent ID**: ${AGENT_ID}
- **Work dir**: fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` (path looks like `~/worktrees/<base>-<sha4>-har-agent-${AGENT_ID}-<rand4>`)
- **Infra**: none for this repo (`HARNESS_INFRA_SERVICES` is empty)

Launch FIRST, then make ALL file edits under the work dir. Prefer complete/teardown then launch to free a slot. `--replace` abandons the previous session from main-checkout HEAD (does not select main). Always set `--purpose`. Dirty previous sessions need `--force` after user approval.

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

Harness control-plane commands (MCP / `har env`) target the main repo checkout; project commands run in your work dir.

## Verification

**Preferred — MCP:** `har_run_verification` with `agentId: ${AGENT_ID}` (fast) and `full: true` (required before done).

**CLI:**

```bash
har env verify ${AGENT_ID}
har env verify ${AGENT_ID} --full
```

**Shell fallback:**

```bash
./.har/verify.sh ${AGENT_ID}
./.har/verify.sh ${AGENT_ID} --full
```

Full verify also runs `HARNESS_READINESS_CMD` when configured. This CLI harness
does not need a runtime usability smoke today, so the readiness step skips by
default.

## Definition of Done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full`, MCP `har_run_verification` with `full: true`, or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] When `stages/browser-e2e.sh` exists, full verify includes Playwright — adapt specs under `tests/` for UI changes
- [ ] Tests cover the change
- [ ] No type errors, no lint warnings
- [ ] Changes committed in your worktree with a clear message
- [ ] Finish with `har env complete ${AGENT_ID}` (or MCP `har_complete_environment`) — records the validation and tears down while **keeping the session branch** for the user to push / open a PR

## What NOT To Do

- **Do NOT** edit the main checkout while your worktree is active — work in the slot work dir
- **Do NOT** run ad-hoc `npm test` from the repo root — use MCP/`har env verify` or `agent-cli.sh exec`
- **Do NOT** edit `.env.agent.${AGENT_ID}` manually

## Architecture notes

See `AGENT.md` for layer boundaries (`cli/` → `core/` → `harness/`). Put template changes in `src/templates/` and run `npm run build` before testing a linked `har` install.

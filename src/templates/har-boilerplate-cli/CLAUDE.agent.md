# Agent ${AGENT_ID} — Development Environment

> [`AGENT.md`](../AGENT.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
```

## Readiness

Adapt this section for the repository. For pure CLI/library repos, full verify
may be enough. If the project needs services, auth, seeded data, or a sample
workflow, document the required credentials/default data and wire a smoke into
`HARNESS_READINESS_CMD` or full verify.

## Definition of done

HAR exists so agents **prove a change works before opening a PR** — not only that the
tree compiles. Quick verify is **smoke only** (compile/import/build). Smoke alone is
**never** done, even if it appears under `verificationStages`.

- [ ] **Change-specific oracle:** at least one verification stage exercises the *behavior
  this change is supposed to fix/add* (CLI/API/workflow/focused regression) — not
  compile/import alone
- [ ] **Fail-before / pass-after:** that oracle **fails** on the broken tree (or before
  your change) and **passes** after. A stage that already passes before the fix is
  not proving the bug — rewrite it
- [ ] **Functional proof:** `har env verify ${AGENT_ID} --full` (or MCP
  `har_run_verification` with `full: true`) returns `"status": "pass"`
- [ ] If no registered stage can confirm this change, **add one on the fly** before stopping:

  ```bash
  har env add-stage <id> --custom --kind test --command "<behavioral check>" --verification
  # or: har env add-stage <id> --custom --script --verification
  ```

  Prefer a small focused regression script wired as that stage. See `.har/STAGES.md`.
  Make sure the check runs in this slot (editable install / `${PYTHON_BIN}` / toolchain
  from `.env.agent.${AGENT_ID}` — do not leave stages that fail only because imports
  or extensions were never built).
- [ ] The slot is agent-usable for this repo's documented smoke workflow when runtime services are involved
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

Quick loop while iterating: `har env verify ${AGENT_ID}` (smoke). Before you stop: `--full` with a real behavioral stage green.

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

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

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Edits there hot-reload in the running slot; use `./.har/agent-cli.sh ${AGENT_ID} restart` if a change doesn't take. An occupied slot always blocks a new launch — run `./.har/teardown.sh ${AGENT_ID}` (or `complete`) first, then launch again.

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

HAR exists so agents **prove a change works before opening a PR** — not only that the
tree compiles. Quick verify is **smoke only** (compile/import/build/health). Smoke
alone is **never** done, even if it is listed under `verificationStages`.

- [ ] **Change-specific oracle:** at least one verification stage exercises the *behavior
  this change is supposed to fix/add* (API/UI/workflow/focused regression) — not
  health/compile/import alone
- [ ] **Fail-before / pass-after:** that oracle **fails** on the broken tree (or before
  your change) and **passes** after. If a new stage already passes before you fix
  anything, it is not proving the bug — rewrite it
- [ ] **Functional proof:** `har env verify ${AGENT_ID} --full` (or MCP
  `har_run_verification` with `full: true`) returns `"status": "pass"`
- [ ] If no registered stage can confirm this change, **add one on the fly** before stopping:

  ```bash
  har env add-stage <id> --custom --kind test --command "<behavioral check>" --verification
  # or: har env add-stage <id> --custom --script --verification
  ```

  Prefer a small focused regression script wired as that stage. See `.har/STAGES.md`.
  Ensure the check can actually run in this slot (deps installed, correct
  `${PYTHON_BIN}` / toolchain from `.env.agent.${AGENT_ID}`).
- [ ] The slot is agent-usable for this repo's documented smoke workflow, not only health-check green
- [ ] When `stages/browser-e2e.sh` exists, adapt specs under `tests/` for UI changes
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] The user got the preview URLs to test the app themselves
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

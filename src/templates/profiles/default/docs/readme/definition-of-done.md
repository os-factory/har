## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify <id> --full`, MCP `har_run_verification` with `full: true`, or `har env verify <id> --full`)
- [ ] The slot is agent-usable for this repo's documented smoke workflow, not only health-check green
- [ ] Full verify runs every registered stage in `stages.json` `verificationStages` (Playwright, custom checks, …) — when `stages/browser-e2e.sh` exists, adapt specs under `tests/` for UI changes
- [ ] New behavior has automated test coverage (unit and/or browser as appropriate)
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] The user got the preview URLs to test the app themselves
- [ ] Present session handoff (summary, branch, preview URLs) and **wait for user** before `complete`, push, or PR
- [ ] On user approval of the default: push + open PR (when `gh`/GitHub MCP available), then `har env complete <id>` (or MCP `har_complete_environment`) — reuse last passing full validation + teardown, branch kept. Pass `--verify` / `verify: true` if the tree may have changed.

### Session handoff

After full verify and commit, stop and propose next steps. Never autonomously run
`complete`, `teardown`, `git push`, or open a PR. **Default recommendation:** when
`gh` or GitHub MCP is available, complete the slot **and** open a PR (push → PR →
`har env complete` / `har_complete_environment`). Offer complete-only or something
else as alternatives. If PR tooling is unavailable, recommend complete and report
the session branch for a manual push. Prefer `complete` over bare `teardown` when
the work succeeded. See `.cursor/rules/har-workflow.mdc` for the handoff shape.

Quick loop during development: MCP `har_run_verification`, `har env verify <id>`, or `har env verify <id>` (smoke + health only; `--full` adds the registered verification stages).

Stages are the harness's single vocabulary for checks: templates and custom stages compile to generic kinds in `.har/stages.json`, and you interact with them only through the registry (`har_run_stage`, `verify`), never stack-specific tooling. Authoring guide: `.har/STAGES.md`.

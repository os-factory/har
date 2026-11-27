# 02 — Slots and session lifecycle

Isolating each agent task in its own numbered slot, from launch to completion.

- **ENV-1** MUST — A slot is a numbered, reusable lane whose allowed range comes from `agentSlots` in `.har/stages.json`; launching an occupied slot is refused.
- **ENV-2** MUST — A normal launch creates a fresh session: a new branch derived from the base branch, a git worktree outside the main checkout, `.env.agent.<id>` with resolved paths/ports/services, and `.har/slots/agent-<id>.json` as the session's source of truth.
- **ENV-3** MUST — Slots of one repository do not share a worktree, ports or (when the profile has one) database.
- **ENV-4** MUST — `--no-worktree` runs the slot in an existing checkout (`mode: external`); teardown of such a slot leaves the checkout in place.
- **ENV-5** MUST — Teardown removes the session worktree and keeps the session branch.
- **ENV-6** MUST — `har env complete` succeeds only when a passing full validation matches the current worktree tree (or `--verify` produces one), records the completed outcome, then tears down; plain teardown never claims completion.
- **ENV-7** MUST — A partial launch can be resumed with `recover`, and `preflight` reports launch blockers (e.g. port conflicts) before launching.
- **ENV-8** SHOULD — `har env status` lists every slot with its branch, work unit and last verification, and reading status writes no run records.
- **ENV-9** MUST — The Claude Code worktree guard blocks agent file edits in the main checkout of a HAR repository (exit 2) and allows them in a session worktree and outside HAR repositories; it fails open on malformed input and is bypassed by `HAR_SKIP_WT_GUARD`.
- **ENV-10** MUST — Launch provisions the toolchain of the project's ecosystem: an explicit `HARNESS_ECOSYSTEM` wins over manifest detection, `HARNESS_INSTALL_CMD` replaces the default install, and a failing install fails the launch.
- **ENV-11** MUST — Only infra services enabled in `HARNESS_INFRA_SERVICES` get a host port from their declared lane; a persisted port is kept while it is free or held by its own compose service, otherwise the lane is scanned, and an enabled service with no free port fails loudly.
- **ENV-12** MUST — PM2 process names are scoped to the project, so the same agent id in two projects never collides and teardown deletes only this project's processes.
- **ENV-13** SHOULD — Preflight warns about untracked, non-ignored paths that will be missing from the session worktree; the check is skipped when the slot runs in the repo root or with `--no-worktree`.
- **ENV-14** MUST — `har env cleanup` builds a plan before destroying anything: stale clean sessions are classified for teardown, `repo:agent` pins are kept, and orphan worktrees are discovered.

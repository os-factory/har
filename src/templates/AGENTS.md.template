# Agent Environment

This repository uses a **`.har/` harness** for isolated agent development.

<!-- har:agent-environment:start -->
## HAR / agent environment

This repository uses a `.har/` harness. It is **how you run and verify this
project** — launch a slot for live apps, browsers and screenshots; never
hand-roll docker or dev-server startup. If a harness command fails, fix the
harness or report it; do not fall back to ad-hoc commands.

1. **Launch first** — `har_launch_environment` / `har env launch <id>`. Make ALL
   edits under the returned **work dir**, never the main checkout. Bind tracker
   work with `--work-id` / `--work-url` when the task names an issue.
2. **Verify before done** — `har_run_verification` (`full: true`) /
   `har env verify <id> --full`. Commit in the session worktree.
3. **Stop at handoff** — report summary, session branch and preview URLs, then
   wait. Never autonomously `complete`, `teardown`, push, or open a PR.
4. **All slots taken?** Occupied slots always block a launch, and you never free
   one yourself. Run `har env status`, then show the user every slot — branch,
   work unit, what it achieves, last verify, and whether its commits are merged,
   pushed or unpushed — and recommend which to close: merged or abandoned work
   with nothing left to do first; never one with unpushed commits. On approval:
   `complete` / `teardown <id>`, then launch.

Customize the harness only through `harness.env`, `stages.json` + `.har/stages/`,
`.har/hooks/` and `.har/plugins/` — there is no generated `.har/*.sh` entry-point
surface.

Full detail — slot environment, readiness, definition of done, project commands,
commit gate: [`.har/README.md`](.har/README.md) and [`.har/stages.json`](.har/stages.json).
<!-- har:agent-environment:end -->

## Project-specific notes

<!-- Adapt when customizing the harness (see .har/ADAPT-PROMPT.md) -->

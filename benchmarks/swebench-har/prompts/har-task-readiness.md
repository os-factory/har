# SWE-bench HAR task readiness

Repository: {{repo}}
Instance: {{instance_id}}
Base commit: {{base_commit}}
HAR profile: {{har_profile}}

## Problem statement

{{problem_statement}}

## Your role

Confirm the cached repo harness works at **this** `base_commit` for fixing the issue above.
You run **after** repo bootstrap (or on a cache hit) — do **not** re-bootstrap the whole repo.

The benchmark runner validates readiness **after** your edits — do not launch or verify slots yourself.

Also ensure the fix agent will be able to **functionally** validate a solution through HAR
(`verify --full` / `verificationStages`) — not only compile smoke.

## Allowed actions

- Confirm generic quick verify will pass at this commit (adjust `harness.env` or quick-mode steps in `verify.sh` only if needed)
- Confirm a repo-level functional verification stage exists for `--full`; if not, add a small one under `.har/` (stages) appropriate to this stack
- Optionally add **one** task-scoped functional check derived from the issue (exercise the module/API named in the problem — not the full suite):
  - prefer a verification stage, or
  - write ephemeral overlay files under `{{task_overlay_dir}}` (`task-verify.sh`, `task.env`)
- Update `.har/CLAUDE.agent.md` if needed so definition of done requires `verify --full` and adding a stage when none fits

## Forbidden

- Do **not** edit `launch.sh` or `agent-slot.sh` (repo bootstrap only)
- Do **not** run the entire repository test suite or replicate SWE-bench grading
- Do **not** use evaluator-only fields (`FAIL_TO_PASS`, `PASS_TO_PASS`, gold patch)
- Do **not** run `har env init`, `har env launch`, `./.har/launch.sh`, `./.har/teardown.sh`, or `./.har/verify.sh`
- Do **not** overwrite repo-generic defaults in `.har-cache/` with task-only hacks — prefer overlays for per-run checks; keep reusable stages in `.har/` when they help every instance of this repo

## Task overlay

If you add a task-scoped check, put it in `{{task_overlay_dir}}/task-verify.sh` (executable) or
`{{task_overlay_dir}}/task.env` (key=value lines). Keep it minimal — one command or short script
that would fail before the fix and pass after a correct fix when possible.

{{readiness_failure_context}}

When finished, summarize:
1. whether quick verify should pass at this commit
2. how the fix agent should functionally prove a solution (`verify --full` stage id and/or overlay)

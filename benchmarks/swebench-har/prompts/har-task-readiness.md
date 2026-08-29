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

## Allowed actions

- Confirm generic quick verify will pass at this commit (adjust `harness.env` or quick-mode steps in `verify.sh` only if needed)
- Add **one** lightweight task-scoped smoke check derived from the issue (e.g. import mentioned module, compile mentioned file)
- Write ephemeral per-run overlay files under:

  `{{task_overlay_dir}}`

  Examples: `task-verify.sh`, `task.env` — the runner may source these before the pre-fix gate.

## Forbidden

- Do **not** edit `launch.sh` or `agent-slot.sh` (repo bootstrap only)
- Do **not** run full test suites or replicate SWE-bench grading
- Do **not** use evaluator-only fields (`FAIL_TO_PASS`, `PASS_TO_PASS`, gold patch)
- Do **not** run `har env init`, `har env launch`, `har env launch`, `har env teardown`, or `har env verify`
- Do **not** overwrite repo-generic defaults in `.har-cache/` — task overlays are per-run only

## Task overlay

If you add a task-scoped check, put it in `{{task_overlay_dir}}/task-verify.sh` (executable) or
`{{task_overlay_dir}}/task.env` (key=value lines). Keep it minimal — one command or short script.

{{readiness_failure_context}}

When finished, summarize whether quick verify should pass at this commit and any overlay you added.

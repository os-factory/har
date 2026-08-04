# SWE-bench HAR task readiness

Repository: {{repo}}
Instance: {{instance_id}}
Base commit: {{base_commit}}
HAR profile: {{har_profile}}

## Problem statement

{{problem_statement}}

## Your role

Confirm the cached repo harness works at **this** `base_commit` for fixing the issue.
You run **after** repo bootstrap (or on a cache hit) — do **not** re-bootstrap the whole repo.

The runner validates readiness **after** your edits — do not launch/verify yourself.

HAR is a **sandbox for verifying code changes**. Prepare a **task-scoped** way for the
fix agent to prove a solution works via `verify --full`.

## Allowed actions

- Confirm quick verify will pass (adjust `harness.env` / quick-mode `verify.sh` only if needed)
- Add **one** task-scoped functional verification stage for *this* issue, e.g.:

  ```bash
  har env add-stage <short-id> --custom --kind test --command "<focused check>" --verification
  # or --script
  ```

  Prefer a check that would **fail before** a correct fix and **pass after**.
  You may add a tiny focused regression script/test and wire it as that stage.
  Keep it narrow — not the full suite, not gold evaluator tests.
- Write overlay notes under `{{task_overlay_dir}}` (`task.env`, `task-verify.sh` optional)
- Update `.har/CLAUDE.agent.md` so done = `verify --full`, and agents may add stages / small tests on the fly

## Forbidden

- Do **not** edit `launch.sh` or `agent-slot.sh`
- Do **not** dump the entire test suite into verification
- Do **not** use evaluator-only fields (`FAIL_TO_PASS`, `PASS_TO_PASS`, gold patch)
- Do **not** run launch/teardown/verify yourself
- Issue-specific stages are **per-run** — the runner strips them from the per-repo cache after the gate so they do not leak into other instances

{{readiness_failure_context}}

When finished, summarize quick-verify readiness and the task-scoped stage (id + what it checks).

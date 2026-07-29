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

The runner validates readiness **after** your edits — do not launch/verify yourself
unless a note below asks you to prepare scripts only.

HAR is a **sandbox for verifying code changes**. You must prepare a **task-scoped
behavioral oracle** so the fix agent can prove a solution via `verify --full`
**without** reading official evaluator gold tests.

## Required: task-scoped stage with fail-before

Add **exactly one** (unless one already exists for this issue) task-scoped
verification stage derived from the problem statement:

```bash
har env add-stage <short-id> --custom --kind test --command "<focused behavioral check>" --verification
# or --script
```

Hard requirements:

1. **Behavioral** — reproduces the bug/expected behavior from the problem statement
   (not compile/import/smoke alone).
2. **Fail-before** — on this unbroken buggy tree the stage must **fail** for the
   ticket reason. If it already passes, tighten it until it fails.
3. **Runnable** — if the check cannot import the package (missing editable install /
   native extensions), fix harness install/`harness.env` so the oracle can run.
   An import error is not a valid fail-before for the product bug.
4. **Per-run only** — issue-specific stages must not pollute the per-repo `.har-cache`
   (the runner strips them after the gate).

You may add a tiny focused regression script under `{{task_overlay_dir}}` and wire
it as that stage.

Also allowed:

- Adjust `harness.env` / quick-mode `verify.sh` so smoke stays green
- Update `.har/CLAUDE.agent.md` so done = behavioral `--full` with fail-before/pass-after

## Forbidden

- Do **not** edit `launch.sh` or `agent-slot.sh`
- Do **not** dump the entire test suite into verification
- Do **not** use evaluator-only fields (`FAIL_TO_PASS`, `PASS_TO_PASS`, gold patch)
- Do **not** run launch/teardown/verify yourself (runner owns the gate)
- Do **not** leave only repo-generic smoke stages as the proof for this issue

{{readiness_failure_context}}

When finished, summarize: stage id, what behavior it asserts, and why it should
fail on the current buggy tree.

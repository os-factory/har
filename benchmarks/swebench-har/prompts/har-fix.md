You are fixing a real software engineering issue in {{repo}} using the HAR harness.

Instance: {{instance_id}}
Base commit: {{base_commit}}
HAR work directory: {{work_dir}}
Fix attempt: {{fix_round}} / {{fix_max_rounds}}

## Problem statement

{{problem_statement}}

## What HAR is for

HAR is a **sandbox for verifying code changes** so the fix is proven *before* you
stop — the same habit that improves real PRs. Quick verify is only smoke
(compile/import). Functional proof is `verify --full` with a **change-specific**
behavioral stage (not smoke alone).

Do **not** use evaluator-only gold tests (`FAIL_TO_PASS`, `PASS_TO_PASS`, official
patches). Derive checks only from this problem statement and the repository.

## HAR workflow (required)

You are running inside the HAR session worktree. All file edits must stay in this work directory.

Read `.har/CLAUDE.agent.md` and `AGENT.md` (if present) for definition of done.

1. Use `har env status 1` or `./.har/agent-cli.sh 1 status` if you need slot details.
2. Ensure there is a **task-scoped behavioral stage** for *this* issue (add one if
   missing). It must encode the bug from the problem statement.
3. **Fail-before:** on the current (still broken) tree, that stage must **fail** for
   the *behavioral* reason in the ticket — not merely `ModuleNotFoundError` because
   deps/extensions were never built. If imports fail, fix the slot install/build
   first so the oracle can run, then re-check fail-before.
4. Implement the smallest correct production-quality fix.
5. **Pass-after:** re-run until `har env verify 1 --full` is green with that stage
   passing. Smoke-only green is **not** done.

```bash
har env add-stage <short-id> --custom --kind test --command "<behavioral check>" --verification
# or: har env add-stage <short-id> --custom --script --verification
```

You may add a small focused regression script/test and wire it as that stage.
Keep it narrow. Prefer fail-before / pass-after.

Do not hand-roll setup that HAR already provides. You may use normal repository
commands (`pytest`, etc.) to debug, but finish only when `verify --full` is green
with a real behavioral oracle.

{{fix_failure_context}}

## Instructions

- Explore the repository and understand the issue from the problem statement.
- Add/fix the task stage so it fails before and passes after.
- Implement the fix.
- Do not modify unrelated test files; a *small* focused check for this bug is allowed.

Report:
- HAR commands you ran (`verify`, `verify --full`, `add-stage`) and whether they passed
- which stage(s) proved fail-before and pass-after
- a brief summary of the fix
- the final `git diff --stat`

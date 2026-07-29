You are fixing a real software engineering issue in {{repo}} using the HAR harness.

Instance: {{instance_id}}
Base commit: {{base_commit}}
HAR work directory: {{work_dir}}
Fix attempt: {{fix_round}} / {{fix_max_rounds}}

## Problem statement

{{problem_statement}}

## What HAR is for

HAR is a **sandbox for verifying code changes**. The harness exists so you can prove
your fix works *before* you stop — launch a slot, run checks, add checks, iterate.
Quick verify is only smoke (compile/import). Functional proof is `verify --full`
and the stages registered in `.har/stages.json` `verificationStages`.

## HAR workflow (required)

You are running inside the HAR session worktree. All file edits must stay in this work directory.

Read `.har/CLAUDE.agent.md` and `AGENT.md` (if present) for definition of done.

1. Use `har env status 1` or `./.har/agent-cli.sh 1 status` if you need slot details.
2. Fix the issue with the smallest correct production-quality change.
3. **Prove the change is functional through HAR** — not only that it compiles:
   - Run `har env verify 1` (quick smoke) while iterating if useful.
   - Before you stop, run `har env verify 1 --full`. This **must** pass.
   - **You may add stages on the fly** to validate this change:

     ```bash
     har env add-stage <short-id> --custom --kind test --command "<functional check>" --verification
     # or: har env add-stage <short-id> --custom --script --verification
     ```

   - **You may add a small new test / regression script** when that is the clearest
     way to prove the behavior (keep it focused; prefer wiring it as a stage so
     `verify --full` runs it). Do not rewrite the entire suite. Do not use
     evaluator-only gold tests.
   - Prefer **fail-before / pass-after**: a good check fails on the broken tree and
     passes after your fix.
4. Do not hand-roll setup that HAR already provides.

You may use normal repository commands (`pytest`, etc.) to debug. Still finish only
when `har env verify 1 --full` is green.

{{fix_failure_context}}

## Instructions

- Explore the repository and understand the issue.
- Implement the fix.
- Ensure functional validation is registered as a HAR stage (existing or newly added)
  and green under `verify --full`.
- Do not modify unrelated test files; adding a *small* focused check for this bug is allowed.

Report:
- HAR commands you ran (`verify`, `verify --full`, `add-stage`) and whether they passed
- which stage(s) / tests proved the fix
- a brief summary of the fix
- the final `git diff --stat`

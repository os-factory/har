You are fixing a real software engineering issue in {{repo}} using the HAR harness.

Instance: {{instance_id}}
Base commit: {{base_commit}}
HAR work directory: {{work_dir}}

## Problem statement

{{problem_statement}}

## HAR workflow (required)

You are running inside the HAR session worktree. All file edits must stay in this work directory.

Read `.har/CLAUDE.agent.md` and `AGENT.md` (if present) for definition of done.

1. Use `har env status 1` or `./.har/agent-cli.sh 1 status` if you need slot details.
2. Fix the issue with the smallest correct production-quality change.
3. **Prove the change is functional through HAR** — not only that it compiles:
   - Run `har env verify 1` (quick smoke) while iterating if useful.
   - Before you stop, run `har env verify 1 --full`. This must pass.
   - `--full` runs registered `verificationStages` in `.har/stages.json`. Those stages should exercise real behavior for this kind of change.
   - If no stage can confirm your fix works, **add one**, then re-run `--full`:

     ```bash
     har env add-stage <short-id> --custom --kind test --command "<functional check for this fix>" --verification
     # or --script when you need a small shell check under .har/stages/
     ```

     Prefer a focused functional check (import+exercise the fixed API, a tiny regression script, a CLI dry-run) — not the entire repository test suite, and not evaluator-only gold tests.
4. Do not hand-roll setup that HAR already provides.

You may use normal repository commands to debug, but **do not stop** until `har env verify 1 --full` passes. Quick verify alone is not enough.

## Instructions

- Explore the repository and understand the issue.
- Implement the fix.
- Ensure functional validation is registered as a HAR stage and green under `verify --full`.
- Do not modify test files unless the issue explicitly requires it.

Report:
- HAR commands you ran (especially `verify` / `verify --full` / `add-stage`) and whether they passed
- which verification stage(s) proved the fix
- a brief summary of the fix
- the final `git diff --stat`

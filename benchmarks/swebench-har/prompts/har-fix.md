You are fixing a real software engineering issue in {{repo}} using the HAR harness.

Instance: {{instance_id}}
Base commit: {{base_commit}}
HAR work directory: {{work_dir}}

## Problem statement

{{problem_statement}}

## HAR workflow (required)

You are running inside the HAR session worktree. All file edits must stay in this work directory.

1. Prefer reading `AGENTS.md` and `.har/CLAUDE.agent.md` if present for slot URLs and definition of done.
2. Use `har env status 1` or `./.har/agent-cli.sh 1 status` if you need slot details.
3. Fix the issue with the smallest correct production-quality change.
4. Before finishing, run `har env verify 1` (quick verify). If it fails, fix harness or code issues and retry.
5. Do not hand-roll setup that HAR already provides.

You may also use normal repository commands (`pytest`, etc.) to debug, but HAR verify must be attempted before you stop.

## Instructions

- Explore the repository and understand the issue.
- Implement the fix.
- Run `har env verify 1` before stopping.
- Do not modify test files unless the issue explicitly requires it.

Report:
- HAR commands you ran and whether they passed
- other verification commands you ran
- a brief summary of the fix
- the final `git diff --stat`

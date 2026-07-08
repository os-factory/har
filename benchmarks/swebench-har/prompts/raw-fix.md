You are fixing a real software engineering issue in {{repo}}.

Instance: {{instance_id}}
Base commit: {{base_commit}}

## Problem statement

{{problem_statement}}

## Instructions

1. Explore the repository and understand the issue.
2. Implement the smallest correct production-quality fix.
3. Run relevant tests or verification commands from the repository.
4. Stop when you believe the issue is fixed.

Report:
- commands you ran and whether they passed
- a brief summary of the fix
- the final `git diff --stat`

Do not modify test files unless the issue explicitly requires it.

---
title: Agent workflow
description: The safe lifecycle for parallel coding tasks.
---

## Before editing

1. Read the repository's `AGENT.md`, `.har/README.md`, and `.har/stages.json`.
2. Check status before choosing a slot.
3. Launch once and record the returned work directory.
4. Read `.har/CLAUDE.agent.md` in that worktree for resolved URLs and the
   repository-specific definition of done.

```bash
har env status
har env preflight 2
har env launch 2 --purpose="my task label"
```

Use one slot per task. Separate parallel tasks use separate slots.
`--purpose` (or `HAR_SESSION_PURPOSE`) labels the session in status and occupied-slot warnings.

## Occupied and failed slots

A normal launch never silently replaces an active session.

```bash
har env launch 2 --replace
```

Only use `--replace` after reviewing the current branch and worktree. If that
worktree has uncommitted changes, replacement remains blocked until the owner
explicitly approves `--force`.

A launch that failed partway is different. Preserve and resume its existing state:

```bash
har env recover 2
# equivalent to: har env launch 2 --resume
```

## During implementation

- Edit only under the slot's `workDir`.
- Let the harness own service startup, ports, databases, and process management.
- Use preview URLs returned by status or launch instead of hardcoding ports.
- Run focused project commands through `.har/agent-cli.sh <id> exec ...` when needed.
- Use quick verification as the feedback loop.

```bash
har env verify 2
har env status --json
```

## Before handoff

1. Add or update automated tests.
2. Run full verification.
3. Stage exactly the state that passed.
4. Commit inside the session worktree.
5. Complete the environment.

```bash
har env verify 2 --full
git add -A
git commit -m "feat: describe the change"
har env complete 2
```

Any edit after full verification changes the tree hash and requires another full
verify. Completion keeps the branch, so the user can push it or open a pull request.

## When to teardown

Use plain teardown for abandoned work, manual cleanup, or a task that should not
record a completion validation:

```bash
har env teardown 2
```

Branch deletion is a separate, explicit operation.

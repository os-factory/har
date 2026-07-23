---
title: Agent workflow
description: The safe lifecycle for parallel coding tasks.
---

## Before editing

1. Read the repository's `AGENT.md`, `.har/README.md`, and `.har/stages.json`.
2. Check status before choosing a slot.
3. On the **main checkout**, switch to the branch you want as the session base
   (usually `main`) — every launch creates a worktree from that HEAD.
4. Launch once and record the returned work directory.
5. Read `.har/CLAUDE.agent.md` in that worktree for resolved URLs and the
   repository-specific definition of done.

```bash
har env status
har env preflight 2
har env launch 2
```

Use one slot per task. Separate parallel tasks use separate slots.
With telemetry prompts enabled (`har telemetry on --prompts`), Mission Control
fills the session purpose from the first captured user prompt.

## Occupied and failed slots

A normal launch never silently replaces an active session. Prefer finishing the
previous task first:

```bash
har env complete 2   # or: har env teardown 2
har env launch 2
```

To reuse the same slot id immediately, pass `--replace` after reviewing the
occupied warning (it shows the **new** session base — HEAD of `--repo` — not
only the old worktree). `--replace` destroys the previous worktree; it does
**not** select `main`.

```bash
har env launch 2 --replace
```

If that worktree has uncommitted changes, replacement remains blocked until the
owner explicitly approves `--force`.

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

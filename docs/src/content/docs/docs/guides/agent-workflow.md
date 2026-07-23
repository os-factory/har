---
title: Agent workflow
description: The safe lifecycle for parallel coding tasks.
---

## Mental model

| Concept | Role |
| --- | --- |
| **Slot** | Scarce reusable lane (id, ports, DB) |
| **Session** | One task’s ephemeral worktree + env |

Every `launch` creates a **new** session from the current HEAD of the main
checkout (`$REPO_ROOT`). It does **not** inherit the previous session’s branch
identity. `--replace` only means: abandon the previous session on this slot and
start another from whatever that HEAD is right now.

```text
status / preflight
    → launch          (slot free: new session from $REPO_ROOT HEAD)
    → work + verify
    → complete        (done: full verify + free slot, keep branch)
       or teardown    (abandon: free slot, keep branch)

If slot occupied and previous task is done / abandoned:
    → complete or teardown   (preferred)
    → then launch

If slot occupied and you must reuse the same id immediately:
    → --replace              (destroy previous session worktree)
    → --force only if dirty and user approved discard
    → NEW session still comes from main-checkout HEAD
         → switch that checkout to main first for a new unrelated task

If launch failed partway:
    → --resume / recover     (never --replace)
```

## Before editing

1. Read the repository's `AGENT.md`, `.har/README.md`, and `.har/stages.json`.
2. Check status before choosing a slot.
3. For a **new unrelated task**, ensure the main checkout is on `main` (or the
   base the user named) before launch — until `launch --base` exists, HEAD is
   the base.
4. Launch once with a purpose label and record the returned work directory.
5. Read `.har/CLAUDE.agent.md` in that worktree for resolved URLs and the
   repository-specific definition of done.

```bash
har env status
har env preflight 2
har env launch 2 --purpose="fix sqlite backend"
```

Use one slot per task. Separate parallel tasks use separate slots.
Always set `--purpose` / `HAR_SESSION_PURPOSE` (or MCP `purpose`) as the
human-facing task label shown in status and occupied-slot warnings.
With telemetry prompts enabled (`har telemetry on --prompts`), Mission Control
can also fill purpose from the first captured user prompt.

## Occupied and failed slots

A normal launch never silently replaces an active session.

When the user asks to **free** or **clean** slots, prefer:

```bash
har env complete 2    # finished handoff
# or
har env teardown 2    # abandon
har env launch 2 --purpose="next task"
```

Only use `--replace` when you must reuse the same slot id immediately:

```bash
har env launch 2 --replace --purpose="next task"
```

`--replace` does **not** select `main` and does **not** mean “continue / inherit
the previous task.” Review the occupied-slot warning: it shows what will be
destroyed **and** what the new session will be based on (`$REPO_ROOT` branch @
sha). If that base is a leftover feature branch, switch the main checkout first.

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
5. Complete the environment so Mission Control does not keep a misleading active
   worktree path.

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

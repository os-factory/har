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
With telemetry on (the default, including prompts), Mission Control fills the
session purpose from the first captured user prompt.

## Occupied and failed slots

An occupied slot always blocks a new launch. Free it first, then launch again:

```bash
har env complete 2   # or: har env teardown 2
har env launch 2
```

The occupied error shows the **new** session base — HEAD of `--repo` — so you
can confirm it before freeing the slot. `complete`/`teardown` remove the
previous worktree; the session branch is kept only if you committed. Launch
never chooses `main` for you — switch the main checkout to your intended base
first.

If that worktree has uncommitted changes, commit or discard them in the
worktree before running `complete`/`teardown`.

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
5. Present a **session handoff** and wait for the user's next instruction.
6. On user approval: complete the environment (and optionally open a PR).

```bash
har env verify 2 --full
git add -A
git commit -m "feat: describe the change"
# hand off → wait for user → on approval:
har env complete 2
```

Any edit after full verification changes the tree hash and requires another full
verify.

### What agents must propose

After verify and commit, the agent should stop and offer numbered options — not
silently finish the session:

1. **Complete the slot** (recommended) — `har env complete <id>` / MCP
   `har_complete_environment` runs full verification, records the validated tree
   hash, tears down the worktree/runtime, and **keeps the session branch**. Prefer
   this over bare `teardown` when the work succeeded.
2. **Open a pull request** — only when `gh` or GitHub MCP is available, and only
   after explicit user approval.
3. **Keep the branch only** — if PR tooling is unavailable, report the session
   branch name so the user can push manually. Omit option 2 and describe a manual
   push instead when PR tooling is unavailable.

Never run `complete`, `teardown`, `git push`, or create a PR without user
approval. Canonical handoff shape:

```markdown
## Session handoff

**Summary:** …
**Branch:** `<session-branch>` (session worktree)
**Preview:** … (if applicable)

Next steps — tell me which you want:
1. **Complete the slot** — I'll run `har env complete <id>` (full verify + validation record + teardown; branch kept)
2. **Open a PR** — I can create one with `gh`/GitHub MCP (requires your approval)
3. **Something else** — e.g. keep the slot running, more changes, or push only

I'll wait for your instruction before running complete, teardown, push, or PR.
```

## When to teardown

Use plain teardown for abandoned work, manual cleanup, or a task that should not
record a completion validation:

```bash
har env teardown 2
```

Branch deletion is a separate, explicit operation. Prefer `complete` when the
task succeeded and you want a validation record.

# Work in a har worktree slot

This repository uses a `.har/` harness. All code changes happen inside a **har session worktree**, never in the main checkout. Follow this flow for the current task.

Use har's worktree, not your own: do not create git worktrees yourself and do not use any built-in worktree/isolation feature of your agent harness — the har slot already provides the worktree plus ports, env, and lifecycle.

## 1. Pick a slot

```bash
har env status        # or ./.har/agent-cli.sh 1 status
```

- One slot ≈ one task. If slot 1 is occupied by unrelated work, use slot 2+ (limit: `agentSlots` in `.har/stages.json`).
- Never replace an occupied slot (`--replace`/`--force`) without the user explicitly approving it.

## 2. Launch — BEFORE editing any file

```bash
har env launch <id>   # or ./.har/launch.sh <id>
```

Launch creates a fresh session worktree from HEAD and prints its **work dir** (also recorded in `.har/slots/agent-<id>.json`, path like `~/worktrees/<base>-<sha4>-har-agent-<id>-<rand4>`). If a previous launch failed partway, retry with `--resume` instead of replacing.

If the task already has a stable issue or ticket ID, bind it without changing the
methodology that produced it:

```bash
har env launch <id> --work-id "<provider-neutral-id>" --work-title "<title>"
```

External planning/TDD/review skills remain in control of implementation strategy.
They must delegate worktree creation, runtime launch, final verification, and
completion to HAR.

## 3. Do ALL work in the work dir

- `cd` into the work dir; every read-modify-write of project files happens there.
- The main checkout must stay clean (`git status` there shows no changes from you).
- Edits hot-reload in the running slot; use `./.har/agent-cli.sh <id> restart` if a change doesn't take.
- Commit early and often on the session branch — teardown keeps the branch, not uncommitted work.
- After launch, read `.har/CLAUDE.agent.md` in the worktree for slot URLs and the definition of done.

## 4. Verify through the harness

```bash
har env verify <id>          # fast loop while iterating
har env verify <id> --full   # required before declaring work done
```

Do not substitute ad-hoc test commands for harness verification. Any edit after a full verify — even one character — requires re-running it.

## 5. Finish

```bash
har env complete <id>   # full verify + validation record + teardown, keeps the session branch
```

Report to the user: verification result, the session branch name (so they can push / open a PR), and the slot preview URLs if the app is running.

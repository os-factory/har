## Session lifecycle

Every `launch` starts a **fresh session**: a new git worktree from the **main
checkout's current HEAD** at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
Switch that checkout to your intended base before launch. The session is recorded in
`.har/slots/agent-<id>.json` (the slot registry) — status, verify, and teardown resolve
the work dir through it. Make ALL file edits under the work dir printed by launch,
never in the main checkout.

- Occupied slots always block a new launch: `har env complete <id>` (or `teardown <id>`),
  then `har env launch <id>`. A new launch never chooses `main` for you — switch the
  main checkout to your intended base first.
- `teardown` removes the worktree but **keeps the session branch** so you can push it
  or open a PR (`--delete-branch` to drop it).
- If launch fails after creating a worktree/env file, the registry records `status: failed`.
  Resume it instead of starting fresh: `har env launch <id> --resume` or `har env recover <id>`.
- `har env complete <id>` finishes a session: reuses the last matching passing
  full validation, then teardown — branch kept. Pass `--verify` to re-run full
  verify if the tree may have changed.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

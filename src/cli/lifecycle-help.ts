/**
 * Shared CLI epilog / describe copy for the slot→session launch lifecycle.
 * Keep in sync with docs/guides/agent-workflow.md and the cursor-rule template.
 */

export const HAR_TYPICAL_WORKFLOW_EPILOG = `
Typical agent workflow:
  har env status / preflight <id>
  har env launch <id> [--purpose=label]   # new session from main-checkout HEAD
  har env verify <id>                     # fast loop
  har env verify <id> --full              # before done
  har env complete <id>                   # done: full verify + free slot, keep branch
  # or: har env teardown <id>             # abandon: free slot, keep branch

Slot = reusable lane (id, ports, DB). Session = one task's worktree + env.
--replace abandons the previous session on that slot; it does NOT select main
or inherit the old task's branch. Prefer complete/teardown, then launch.
For a new unrelated task, switch the main checkout to main before launch.
`.trim();

export const ENV_LIFECYCLE_EPILOG = `
Session lifecycle (env subcommands):
  preflight  Check whether a slot can launch (ports, PM2, Docker, occupation)
  launch     New session worktree from $REPO_ROOT HEAD (main checkout)
  recover    Resume a failed/partial launch (alias: launch --resume)
  verify     Quick or --full verification in the session work dir
  complete   Done handoff: full verify + teardown; keep branch for PR
  teardown   Abandon/cleanup: free the slot; keep branch (--delete-branch to drop)
  status     Inspect slots

Cleaning a slot: prefer complete or teardown, then launch — not launch --replace.
--replace only when you must reuse the same slot id immediately.
`.trim();

export const LAUNCH_COMMAND_DESCRIBE =
  'Create a new session worktree from main-checkout HEAD ($REPO_ROOT); does not inherit the previous task';

export const LAUNCH_LIFECYCLE_EPILOG = `
Every launch creates a NEW session from the current HEAD of the main checkout
($REPO_ROOT) — not from the previous session's branch.

  --purpose     Human/Mission-Control-facing task label (also HAR_SESSION_PURPOSE).
                Recommended on every launch. Does not select the git base.
  --replace     Abandon the previous session on this slot and start another.
                Does NOT mean "continue the old task" and does NOT select main.
                Prefer: complete/teardown, then launch.
  --force       With --replace only: discard dirty uncommitted work after
                explicit user approval. Never set autonomously.
  --resume      Recover a failed/starting launch without --replace
                (alias: har env recover <id>).

For a new unrelated task, ensure the main checkout is on main (or your named
base) before launch. Stacking on the current feature branch is intentional when
that checkout is already on that branch.
`.trim();

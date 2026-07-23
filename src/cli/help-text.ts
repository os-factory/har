/** Shared CLI epilog / launch copy for `har --help` and `har env` help. */

export const HAR_ROOT_EPILOG = `Typical agent workflow:
  har env status                 # see which slots are free / occupied
  har env launch <id>            # new session from the main checkout's HEAD
  # …edit only under the printed work dir…
  har env verify <id> --full
  har env complete <id>          # done: verify + free the slot (branch kept for PR)

Slot lifecycle (do not confuse these):
  launch     start a NEW session (worktree from $REPO_ROOT HEAD)
  recover    resume a failed/partial launch (keeps the existing worktree)
  complete   finish successfully: full verify, then teardown (frees the slot)
  teardown   abandon / free the slot without a completion validation

  --replace  only confirms destroying a previous session on that slot id
             it does NOT choose main — new session still uses current HEAD
  --force    additionally discard dirty uncommitted work (user approval only)
  --resume   recover failed/starting; never use --replace for that

For a new unrelated task: checkout main (or your intended base) on the main
repo checkout, free the slot (complete/teardown), then launch.`;

export const HAR_ENV_EPILOG = `Environment lifecycle:
  preflight <id>   dry-run: ports, PM2, Docker, occupied-slot gates
  launch <id>      fresh session worktree from the main checkout's current HEAD
  recover <id>     alias for launch --resume (failed/starting only)
  verify <id>      run checks (--full before declaring done)
  complete <id>    full verify + teardown; keeps branch for push/PR (frees slot)
  teardown <id>    free the slot without recording a completion validation

Occupied slots:
  Prefer complete/teardown when the previous task is finished, then launch.
  Use --replace only to reuse the same slot id immediately (destroys old worktree).
  --replace does not select the base branch — HEAD of --repo does.
  Dirty previous worktree also needs --force after explicit user approval.`;

export const LAUNCH_COMMAND_DESCRIBE =
  'Start a fresh agent session (new worktree from the main checkout HEAD)';

export const LAUNCH_REPLACE_DESCRIBE =
  'Destroy the previous session on this slot and start another (does not choose main; still uses --repo HEAD)';

export const LAUNCH_FORCE_DESCRIBE =
  'With --replace: discard uncommitted changes in the old worktree (only after explicit user approval)';

export const LAUNCH_RESUME_DESCRIBE =
  'Continue a failed or starting launch without creating a new worktree (prefer over --replace)';

export const LAUNCH_EPILOG = `Every launch creates a NEW session from the current HEAD of --repo (the main
checkout). The worktree path encodes that base branch — switch --repo to main
before launch for a new unrelated task unless you intentionally stack on a
feature branch.

  Free slot:     har env launch 1
  Occupied:      har env complete 1   # or teardown — then launch
                 har env launch 1 --replace          # reuse slot id now
                 har env launch 1 --replace --force  # + discard dirty work
  Failed launch: har env recover 1    # or: har env launch 1 --resume`;

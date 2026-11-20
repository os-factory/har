/** Shared CLI epilog / launch copy for `har --help` and `har env` help. */

export const HAR_ROOT_EPILOG = `First time in a repo:
  har onboard                    # guided setup → adaptation prompt on clipboard

Typical agent workflow:
  har env status                 # see which slots are free / occupied
  har env launch <id>            # new session from the main checkout's HEAD
  # …edit only under the printed work dir…
  har env verify <id> --full
  har env complete <id>          # done: reuse last full validation + free the slot (branch kept for PR)

Slot lifecycle (do not confuse these):
  launch     start a NEW session from $REPO_ROOT HEAD (worktree unless turned off)
  recover    resume a failed/partial launch (keeps its work dir)
  complete   finish successfully: reuse last matching full validation, then teardown (frees the slot)
  teardown   abandon / free the slot without a completion validation

Occupied slots always block a new launch:
  har env complete <id>   # or: har env teardown <id>
  har env launch <id>     # then start the new session

  --resume   recover a failed/starting session; never needed for a fresh launch

For a new unrelated task: checkout main (or your intended base) on the main
repo checkout, free the slot (complete/teardown), then launch.

Session worktrees are on by default; your personal choice per repo or globally:
  har worktree status            # effective mode and which setting decided it
  har worktree off [--global]    # launch in the checkout itself (undo: on, reset)`;

export const HAR_ENV_EPILOG = `Environment lifecycle:
  preflight <id>   dry-run: ports, PM2, Docker, occupied-slot gates, untracked paths
  launch <id>      fresh session from the main checkout's HEAD (see: har worktree)
  recover <id>     alias for launch --resume (failed/starting only)
  verify <id>      run checks (--full before declaring done)
  complete <id>    reuse last full validation + teardown; --verify to re-run; keeps branch (frees slot)
  teardown <id>    free the slot without recording a completion validation

Occupied slots:
  Always blocked for a fresh launch — free the slot first, then launch again:
    har env complete <id>   # or: har env teardown <id>
    har env launch <id>
  A new launch uses the main checkout's current HEAD — switch that checkout to
  your intended base first.
  Failed/starting sessions can be resumed instead: har env launch <id> --resume
  (or har env recover <id>).`;

export const LAUNCH_COMMAND_DESCRIBE =
  'Start a fresh agent session from the main checkout HEAD (see: har worktree)';

export const LAUNCH_RESUME_DESCRIBE =
  'Continue a failed or starting launch in its existing work dir';

export const LAUNCH_EPILOG = `Every launch creates a NEW session from the current HEAD of --repo (the main
checkout). The worktree path encodes that base branch — switch --repo to main
before launch for a new unrelated task unless you intentionally stack on a
feature branch.

Whether the session gets its own worktree comes from --worktree/--no-worktree,
then HAR_WORKTREE=on|off, your har worktree setting, HARNESS_USE_WORKTREE in
.har/harness.env, then on. With worktrees off the session runs in --repo itself
and no session branch is created.

  Free slot:     har env launch 1
  Occupied:      har env complete 1   # or teardown
                 har env launch 1     # then start the new session
  Failed launch: har env recover 1    # or: har env launch 1 --resume`;

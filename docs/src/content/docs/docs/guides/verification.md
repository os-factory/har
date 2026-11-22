---
title: Verification and commit gate
description: Bind successful checks to exact code and enforce the result at commit time.
---

## Quick and full verification

```bash
har env verify 1
har env verify 1 --full
har env verify 1 --full --json   # structured result only
```

Quick verification should be fast enough for iteration. Full verification is the
repository's completion contract. The exact commands are adapted in
`.har/stages.json`; typical full checks include unit tests, lint, readiness, browser
E2E, and project-specific stages.

`har env verify` streams progress to stderr. It does not dump the per-step JSON
contract afterward — that duplicated CI logs and agent context. Scripts that
need the object can pass `--json`. Passing steps omit `output`; failed steps
include a truncated excerpt.

HAR records CLI and MCP verification as run JSON and records the exact Git tree state
for full verification. A later source edit invalidates that validation.

## Install the commit gate

Init and maintain now offer to install the gate according to the user's onboarding
preferences. Configure that default once:

```bash
har preferences configure
```

Install or inspect it directly at any time:

```bash
har hooks install
har hooks status
```

HAR installs repository-level pre-commit and post-commit hooks that cover its
worktrees:

- pre-commit hashes the staged change batch and compares it with successful full
  validation;
- post-commit associates the new commit SHA with that validation.

The gate is intentionally based on content, not timestamps or branch names.

## Configure policy

In `.har/stages.json`:

```json
{
  "commitGate": {
    "enabled": true,
    "mode": "block",
    "scope": "worktrees"
  }
}
```

`mode` can be `block` or `warn`. `scope` can be `worktrees` or `all`; the default
worktree scope enforces agent sessions while warning in ordinary checkouts.

## Correct sequence

```bash
har env verify 1 --full
git add -A
git commit -m "fix: explain the validated change"
```

Stage everything that was verified. A partially staged tree is a different batch
and should not pass the gate. Never bypass hooks to force an agent commit; run the
required validation against the intended state.

## Factory Commits proofs (opt-in)

HAR can record its validations as [Factory Commits](https://github.com/os-factory/factory-commits)
proofs in git. HAR builds a `factory-run` predicate from each full validation.
The `git-factory` executable (`HAR_FACTORY_PROOF_BIN`, else `PATH`) builds the
statement and writes notes, trailers and verification. Opt in per repository in
`.har/harness.env`:

```bash
HAR_FACTORY_PROOF=notes            # off (default) | notes | notes+trailers
```

- `off` changes nothing.
- `notes`:
  - every `har env verify --full` attests the validated tree, stored next to
    the validation record;
  - post-commit adds that attestation to `refs/notes/factory` on the new commit;
  - `har hooks install` runs `git factory setup` (fetch refspec,
    `notes.rewriteRef`), and `har hooks uninstall` undoes it.
- `notes+trailers`: everything in `notes`, plus a managed commit-msg hook that
  adds `Work-Unit`, `Factory-Run` and `Factory-Attestation` trailers for a
  verified tree. Re-run `har hooks install` after changing the mode.

Proofs never block verify or a commit. When `git-factory` is missing or fails,
HAR prints one line and carries on. Predicates never contain absolute paths,
prompts, or work-unit titles or URLs.

Inspect and verify proofs with `har proof show [rev]` and
`har proof verify [rev|A..B] [--min-level L0|L1|L2|L3] [--allowed-signers <file>] [--json]`.
MCP agents use `har_proof_show` and `har_proof_verify`. Both pass `git factory`
output and exit codes through.

## Completion

`har env complete 1` reuses the last passing **full** validation whose tree hash
matches the current worktree, then tears the slot down and keeps the session
branch. Verify-before-done already recorded that proof — complete does not
re-run the suite by default.

If the tree changed after that verify (or there is no matching passing full
validation), complete refuses and tells you to re-run:

```bash
har env complete 1 --verify
```

`--verify` is the previous default: full verification, record validation, then
teardown. Use `har env teardown 1` for cleanup without claiming completion.
`--skip-verify` is a deprecated no-op; skip is already the default.

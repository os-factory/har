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

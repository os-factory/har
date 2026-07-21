---
title: Verification and commit gate
description: Bind successful checks to exact code and enforce the result at commit time.
---

## Quick and full verification

```bash
har env verify 1
har env verify 1 --full
```

Quick verification should be fast enough for iteration. Full verification is the
repository's completion contract. The exact commands are adapted in
`.har/verify.sh`; typical full checks include unit tests, lint, readiness, browser
E2E, and project-specific stages.

HAR records CLI and MCP verification as run JSON and records the exact Git tree state
for full verification. A later source edit invalidates that validation.

## Install the commit gate

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

`har env complete 1` performs full verification before teardown and keeps the
session branch. It is the simplest reliable end-of-task operation.

`--skip-verify` exists for explicit cleanup, but it records no validation and should
not be used to claim a completed task.

---
title: Doctor
description: har env doctor — validate the harness contract.
---

`har env doctor` validates that the `.har/` configuration surface is coherent —
the counterpart to drift tracking, which watches *changes*; doctor checks the
*contract*.

```bash
har env doctor          # human-readable report
har env doctor --json   # machine-readable, for CI or agents
```

Exit code is non-zero when any check fails, so doctor slots directly into CI.

## Checks

| Check | Validates |
| --- | --- |
| `harness.env` schema | Pure `KEY=value` config, known keys, valid values — no shell functions |
| `stages.json` registry | Parseable registry, valid stage entries and tiers |
| Stage scripts & commands | Every stage that names a script resolves to an existing executable file |
| Lifecycle stages | The launch/verify/teardown lifecycle is intact |
| `verificationStages` ids | Every listed id resolves to a registered stage |
| Infra port lanes | Every service in `HARNESS_INFRA_SERVICES` has a lane in `HARNESS_INFRA_PORT_LANES` |
| Slot registry worktrees | Registered active sessions point at worktrees that still exist |
| Lifecycle hooks | Files in `.har/hooks/` use known hook names and are executable (content is user-owned, never inspected) |
| Ejected runtime | On an [ejected](/docs/guides/eject/) harness: the vendored runtime exists and scripts point at it |

Doctor detects the harness contract generation: on a pre-1.0 harness (legacy
shell functions or port triplets in `harness.env`) it reports the old shape and
points at the [1.0 migration](/docs/guides/migrating-to-1-0/) instead of
failing every schema check.

## What doctor does not do

Doctor never judges your customizations — an adapted stage command, a hook's
contents, or ejected scripts are yours. It only verifies the pieces still fit
together: ids resolve, schema holds, files exist, lanes are declared.

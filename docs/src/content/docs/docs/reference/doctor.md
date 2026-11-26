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
| CLI vs harness writer | Running CLI is not older than `manifest.cliVersion` (the last CLI that wrote the harness) |
| `harness.env` schema | Pure `KEY=value` config, known keys, valid values — no shell functions |
| `stages.json` registry | Parseable registry, valid stage entries and tiers |
| Stage scripts & commands | Every stage that names a script resolves to an existing executable file |
| Lifecycle stages | The launch/verify/teardown lifecycle is intact |
| `verificationStages` ids | Every listed id resolves to a registered stage |
| Infra port lanes | Every service in `HARNESS_INFRA_SERVICES` has a lane in `HARNESS_INFRA_PORT_LANES` |
| Slot registry worktrees | Registered active sessions point at worktrees that still exist |
| Lifecycle hooks | Files in `.har/hooks/` use known hook names and are executable (content is user-owned, never inspected) |
| Ejected runtime | On an [ejected](/docs/guides/eject/) harness: the vendored runtime exists |
| Telemetry destinations | What each [telemetry destination](/docs/guides/otlp-backends/#destination-health) has queued, dropped in the last 24 h, or failed on in the last hour (`langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)`), from `otel-hook doctor --json` and the CLI's verification spool. Warns only, never fails; skipped with a note when telemetry is off or otel-hook is not installed. Header values are never printed |
| Ingest destinations | One line per ingest v2 receiver in the [destination list](/docs/reference/cli/#destinations-one-list-for-everything-har-sends) (Mission Control, HAR HQ): records, proofs and evidence queued, last success, last error, and whether `GET v2/capabilities` answers. A receiver that does not support ingest v2 yet is named as such (`hq: … does not support ingest v2 (GET v2/capabilities: HTTP 404) — upgrade the receiver`). Warns only, never fails. Key values are never printed |

Doctor detects the harness contract generation: on a pre-1.0 harness (legacy
shell functions or port triplets in `harness.env`) it reports the old shape and
points at the [1.0 migration](/docs/guides/migrating-to-1-0/) instead of
failing every schema check.

When `manifest.cliVersion` is newer than the running CLI, doctor stops with a
single upgrade error (`npm install -g @osfactory/har@latest`) and skips the
rest of the report. A stale CLI otherwise invents "missing `stages/launch.sh`"
findings for lifecycle stages that now live in the package. `init`, `maintain`,
`add-plugin`, and `line add` stamp `cliVersion`. A repo-local newer
`@osfactory/har` (this checkout, or `node_modules/@osfactory/har`) is preferred
over a stale global install.

## What doctor does not do

Doctor never judges your customizations — an adapted stage command, a hook's
contents, or ejected scripts are yours. It only verifies the pieces still fit
together: ids resolve, schema holds, files exist, lanes are declared.

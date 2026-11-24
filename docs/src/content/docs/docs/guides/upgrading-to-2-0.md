---
title: Upgrading to 2.0
description: What HAR 2.0 adds, the default it changes, what it sends by default, and the har.* telemetry attributes it removes.
---

HAR 2.0 makes HAR a producer of open standards: standard OpenTelemetry that any
OTLP backend can read, and [Factory Commits](https://github.com/os-factory/factory-commits)
proofs recorded in git. Both are correlated by the same keys: work unit, attempt,
factory run, git tree, commit and trace.

The major version marks two breaks: one changed default, and **the removal of every
`har.*` telemetry attribute** in favor of OpenTelemetry semantic-convention and
`factory.*` names ([removed attributes](#removed-telemetry-attributes)). Every 1.x
command, flag, config key, HQ sync payload and Mission Control route still works
with the same shape.

```bash
npm install -g @osfactory/har@latest
har env maintain
har env verify 1 --full
```

## What's new

- **OTLP destinations.** `har telemetry destination add|list|remove|test` sends a
  copy of HAR's telemetry to [Langfuse](/docs/guides/langfuse/) or
  [any OTLP backend](/docs/guides/otlp-backends/) (an OpenTelemetry Collector,
  Datadog, …). Mission Control forwards what its receivers accept, through a durable
  spool with retry. Nothing leaves the machine until you add a destination.
- **Verification spans.** Each `har env verify` emits a `cicd.pipeline.run` span
  with one task span per stage. They carry ids, results and timings only. When
  Mission Control is running, the trace goes through it: Mission Control stores it
  as a verification run, syncs it to HQ, and forwards it to every destination
  subscribed to `traces`. Otherwise the CLI sends it to the destinations itself and
  queues failures in `~/.har/spool/traces` for a retry at the next verify or launch,
  or `har telemetry destination flush`. See
  [How verification traces are delivered](/docs/guides/otlp-backends/#how-verification-traces-are-delivered).
- **Semantic-convention attributes.** Agent sessions and verification traces carry
  `factory.*`, `vcs.*`, `cicd.*` and `gen_ai.*` attributes from the Factory Commits
  [telemetry profile](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md),
  in place of the `har.*` ones (see [Removed telemetry attributes](#removed-telemetry-attributes)).
- **Agent traces without Mission Control.** With Mission Control disabled or not
  set up, otel-hook sends agent session traces itself to every `traces` or `logs`
  destination, one or several, without local paths and with the keys in a `0600`
  file. See [Direct export needs otel-hook 0.9.0](#direct-export-needs-otel-hook-090) and
  [Langfuse without Mission Control](/docs/guides/langfuse/#without-mission-control).
- **Factory Commits proofs.** A full verify becomes an in-toto `factory-run`
  statement for the exact verified tree. The commit of that tree gets it as a note
  in `refs/notes/factory`, and optionally as trailers. `har proof show|verify`
  (MCP: `har_proof_show`, `har_proof_verify`) reads them. The predicate carries the
  verification trace id when that trace is exported, so a proof leads to its trace.
  Proofs need `git-factory` from `@osfactory/factory-proof` 0.2.0 or newer, and are
  always `self-reported`: they say what this checkout reports, not that an
  independent runner checked it.
  See [Record Factory Commits proofs](/docs/guides/factory-commits/).

## What changed by default

**Proof notes are written locally when `git factory` is installed.** When
`HAR_FACTORY_PROOF` is not set in `.har/harness.env`, the mode is now `notes`:

- with `git-factory` on `PATH` (or `HAR_FACTORY_PROOF_BIN`), each full verify
  writes an attestation next to the validation record, and the `post-commit` hook
  adds it to the new commit's note in `refs/notes/factory`. Notes stay local:
  git does not push them unless you push `refs/notes/factory`;
- without `git-factory`, nothing happens and nothing is printed;
- `har hooks install` does **not** run `git factory setup` under the default, so
  your git config and fetch refspecs are unchanged;
- trailers are never on by default, because they rewrite commit messages.

To keep the 1.x behavior, set the mode explicitly:

```bash
HAR_FACTORY_PROOF=off              # in .har/harness.env
```

An explicit `off`, `notes` or `notes+trailers` behaves exactly as before.

## Privacy defaults

What a default user sends to a third party, in one sentence: nothing until a
destination is added, and then verification spans, agent session spans and Claude
Code metrics, without local paths, account identity or prompt, reply and tool text.

| Data | Forwarded by default? | Opt in with |
|---|---|---|
| Absolute local paths (every `factory.local.*` key, `process.cwd`, `code.filepath`, …) | No, Mission Control strips them | `--include-local-paths` |
| Account identity (`user.email`, `user.account_uuid`, `user.id`, `organization.id`, …) | No, Mission Control strips them | `--include-account-identity` |
| Logs (at the `full` level they carry prompts, replies and tool input/output) | No, no preset subscribes to logs | `--signals traces,metrics,logs` |

The flags go on `har telemetry destination add`. Mission Control keeps everything
locally as before. The full lists of stripped attributes are in
[Send telemetry to any OTLP backend](/docs/guides/otlp-backends/#privacy). Proofs
never contain prompts, stage logs, absolute paths or work unit titles.

## Removed telemetry attributes

HAR 2.0 no longer emits or reads any `har.*` OpenTelemetry attribute. There is no
dual emission: a dashboard, alert or query that filters on a `har.*` key matches
nothing after the upgrade. Mission Control reads only the new names, so upgrade
HAR and Mission Control together (`har control up` after installing 2.0).

| Removed (1.x) | 2.0 name |
|---|---|
| `har.session_key` | `session.id` (OTel semconv) on the agent session's Resource |
| `har.work_unit_id` | `factory.work_unit.id` (and `factory.work_unit.source` for the tracker) |
| `har.attempt_id` | `factory.attempt.id` |
| `har.branch` | `vcs.ref.head.name` |
| `har.agent_id` | `factory.slot.id` |
| `har.suffix` | removed, nothing read it |
| `har.repo_path` | `factory.local.checkout_path` |
| `har.work_dir` | `factory.local.work_dir` |
| `har.harvest.truncated`, `har.harvest.dropped_events`, `har.harvest.total_events` | `factory.usage.harvest.truncated`, `factory.usage.harvest.dropped_events`, `factory.usage.harvest.total_events` |
| `har.destination_test` (`har telemetry destination test`) | `factory.telemetry.destination_test` |
| Instrumentation scope `har.verification` (and `har.telemetry.destination-test`) | Scope `@osfactory/har` |

`factory.local.*` is a **local-only** namespace: absolute paths and other
machine-local facts Mission Control needs for attribution. Mission Control strips
every `factory.local.*` key from each copy it forwards, unless the destination was
added with `--include-local-paths`.

The agent env file (`.env.agent.<id>`) no longer sets `HAR_SESSION_KEY`: the
session key travels only as `session.id` in `OTEL_RESOURCE_ATTRIBUTES`.
`HAR_WORK_UNIT_ID`, `HAR_ATTEMPT_ID` and `HAR_CONTROL_API_URL` are unchanged.

### Agent hooks (`@osfactory/otel-hook`)

HAR 2.0 installs `@osfactory/otel-hook@0.9.0`. It names each span's session from the
Resource `session.id` HAR sets, so agent spans group by HAR session in any backend.
HAR replaces an older installed copy on the next `har env launch` or
`har telemetry on`.

#### Direct export needs otel-hook 0.9.0

- **Direct export (agent traces without Mission Control) now requires
  `@osfactory/otel-hook` 0.9.0.** HAR installs or upgrades it automatically on
  `har env launch` and `har telemetry on`. Until the installed copy is 0.9.0 or
  newer, HAR keeps agent traces on Mission Control and `har telemetry status` names
  the version it needs.
- **Destinations go into the hook config.** HAR writes every direct destination,
  one or several, to `~/.har/otel-hooks/otel_config.json` as otel-hook's
  `exporter.destinations[]`. Each header value there is an `env:` reference (for
  example `"Authorization": "env:HAR_OTEL_DIRECT_HEADER_1_1"`). The secret values are
  kept only in `~/.har/otel-hooks/direct.env` (mode `0600`), which the hook wrapper
  loads. HAR no longer passes a direct destination through the
  `OTEL_EXPORTER_OTLP_*` variables, and now unsets them for the hook, because any of
  them would add a second, unintended destination.
- **Several destinations without Mission Control.** Every enabled destination
  subscribed to `traces` or `logs` receives agent traces directly. Before, two
  `traces` destinations sent everything back through Mission Control.
- **Spool behaviour changes in otel-hook 0.9.0** (both routes). A full spool now
  drops its oldest batches instead of refusing new ones (default bounds: 16 MiB,
  72 hours and 500 batches per destination). A batch rejected with a non-retryable
  status (anything but `408`, `429`, `500`, `502`, `503` and `504`) is dropped instead
  of spooled, so it no longer blocks the queue. Hook events that close no span no
  longer send an empty request.

See [Without Mission Control](/docs/guides/otlp-backends/#without-mission-control).

To try an unreleased otel-hook build, set `HAR_OTEL_HOOKS_PACKAGE` to any spec your
package manager accepts (a version, an absolute `.tgz` path) before `har telemetry on`.

**Claude Code hooks don't inherit `OTEL_*`.** Since Claude Code 2.1.128, Claude Code
removes every `OTEL_*` variable from the hooks it runs, so otel-hook would see no
`OTEL_RESOURCE_ATTRIBUTES` and export sessions without `session.id`, `factory.*` or
`vcs.*`. HAR therefore also writes the same profile to `.env.agent.<id>` as
`HAR_RESOURCE_ATTRIBUTES`, and the hook wrapper restores `OTEL_RESOURCE_ATTRIBUTES`
from it when the variable arrives empty, before it drops `factory.local.*` on the
direct path. This applies both through Mission Control and with direct export. An
agent started outside a HAR slot has no `HAR_RESOURCE_ATTRIBUTES`, and its hooks
behave as before. Slots launched before this change keep their old agent env file:
relaunch the slot to get the new variable.

## Everything else is unchanged

- No command, flag, config key or MCP tool was renamed or removed. MCP output
  schemas only gained optional fields (for example `proof` on
  `har_run_verification`). `har telemetry destination flush` is new.
- HQ sync payloads and Mission Control's OTLP receivers keep their shapes. Only the
  attribute keys inside the synced event and span `attributes` maps change, as in
  the table above. `/api/sync` gains one optional top-level collection,
  `verificationRuns` (each run with its stages), which receivers that don't know it
  ignore. `/api/otel` bodies are unchanged.
- Proofs and telemetry are fail-open: a missing `git-factory`, a notes error or an
  unreachable destination never blocks verify, a commit or a launch. The commit
  gate is unchanged.

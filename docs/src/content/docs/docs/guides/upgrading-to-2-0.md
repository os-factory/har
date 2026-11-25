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

- **OTLP destinations, fan-out at the producer.**
  `har telemetry destination add|list|remove|test|flush` sends a copy of HAR's
  telemetry to [Langfuse](/docs/guides/langfuse/) or
  [any OTLP backend](/docs/guides/otlp-backends/) (an OpenTelemetry Collector,
  Datadog, …). The producers send to each destination themselves, with a retry spool
  per destination: the agent hook (otel-hook's `exporter.destinations[]`) and the
  CLI (verification traces). Mission Control is one destination among them; it
  stores what it receives and forwards nothing. Nothing leaves the machine until you
  add a destination. See
  [How telemetry reaches a destination](/docs/guides/otlp-backends/#how-telemetry-reaches-a-destination).
- **Verification spans.** Each `har env verify` emits a `cicd.pipeline.run` span
  with one task span per stage, carrying ids, results, timings and the verify policy
  (`factory.policy.id`, `factory.policy.digest`, as in the proof). The CLI sends one
  copy to Mission Control, which stores it as a verification run and syncs it to HQ,
  and one to every destination subscribed to `traces`. A copy that was not taken is
  queued for that receiver in `~/.har/spool/traces` and retried at the next verify or
  launch, or `har telemetry destination flush`, so each receiver gets each trace
  exactly once. See
  [How verification traces are delivered](/docs/guides/otlp-backends/#how-verification-traces-are-delivered).
- **Semantic-convention attributes.** Agent sessions and verification traces carry
  `factory.*`, `vcs.*`, `cicd.*` and `gen_ai.*` attributes from the Factory Commits
  [telemetry profile](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md),
  in place of the `har.*` ones (see [Removed telemetry attributes](#removed-telemetry-attributes)).
- **One agent route, with or without Mission Control.** otel-hook always gets one
  destination list: `mission-control` when Mission Control is enabled and set up,
  plus every enabled `traces` or `logs` destination, with the keys in a `0600` file.
  Without Mission Control the list simply has no `mission-control` entry. See
  [Destinations need otel-hook 0.9.0](#destinations-need-otel-hook-090).
- **Destination health.** `har env doctor` and `har telemetry status` report what
  each destination has queued or dropped and when it last failed, for example
  `langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)`. See
  [Destination health](/docs/guides/otlp-backends/#destination-health).
- **Commit gate names both ids.** The gate's pass line reads
  `har: tree 810a0e26 verified — Factory run 8ec3a247 (proof), verify run 93892f28`:
  the Factory run id is the validation id that the proof (`predicate.run.id`) and
  the traces (`factory.run.id`) carry; the verify run is HAR's record of the one
  `har env verify` invocation. 1.x printed only the latter, as `verified by run`.
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
destination is added, and then verification spans and agent session spans, without
account identity or prompt, reply and tool text, and without local paths except
the `factory.local.*` keys in agent spans while Mission Control is a destination.

| Data | Sent by default? | Opt in with |
|---|---|---|
| Absolute local paths (every `factory.local.*` key, `process.cwd`, `code.filepath`, …) | No, except `factory.local.*` in agent spans while Mission Control is a destination ([#519](https://github.com/os-factory/har/issues/519)) | `--include-local-paths` |
| Account identity (`user.email`, `user.account_uuid`, `user.id`, `organization.id`, …) | No: Claude Code's native telemetry, which carries it, goes to Mission Control only | `--include-account-identity` |
| Logs (at the `full` level they carry prompts, replies and tool input/output) | No, no preset subscribes to logs | `--signals traces,metrics,logs` |
| Claude Code metrics | No, Mission Control only | none |

**Local paths and Mission Control
([#519](https://github.com/os-factory/har/issues/519)).** One agent hook process
sends the same Resource to every destination, and Mission Control needs
`factory.local.*` (the checkout and worktree paths) to attribute sessions. So while
Mission Control is one of the destinations, the others receive those keys too.
Without Mission Control, HAR leaves them out unless every destination has
`--include-local-paths`.

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
machine-local facts Mission Control needs for attribution. The CLI strips every
`factory.local.*` key from each verification copy it sends a destination, unless
the destination was added with `--include-local-paths`. Agent spans keep them while
Mission Control is a destination ([#519](https://github.com/os-factory/har/issues/519)).

The agent env file (`.env.agent.<id>`) no longer sets `HAR_SESSION_KEY`: the
session key travels only as `session.id` in `OTEL_RESOURCE_ATTRIBUTES`.
`HAR_WORK_UNIT_ID`, `HAR_ATTEMPT_ID` and `HAR_CONTROL_API_URL` are unchanged.

### Agent hooks (`@osfactory/otel-hook`)

HAR 2.0 installs `@osfactory/otel-hook@0.9.0`. It names each span's session from the
Resource `session.id` HAR sets, so agent spans group by HAR session in any backend.
HAR replaces an older installed copy on the next `har env launch` or
`har telemetry on`.

#### Destinations need otel-hook 0.9.0

- **Agent traces reach destinations only with `@osfactory/otel-hook` 0.9.0 or
  later.** HAR installs or upgrades it automatically on `har env launch` and
  `har telemetry on`. Until the installed copy is 0.9.0 or newer, HAR sends agent
  traces to Mission Control only and `har telemetry status` names the version it
  needs.
- **Every receiver goes into the hook config.** HAR writes Mission Control and every
  destination to `~/.har/otel-hooks/otel_config.json` as otel-hook's
  `exporter.destinations[]`, Mission Control first, with no single
  `exporter.endpoint`. Each destination header value there is an `env:` reference
  (for example `"Authorization": "env:HAR_OTEL_DIRECT_HEADER_1_1"`). The secret values
  are kept only in `~/.har/otel-hooks/direct.env` (mode `0600`), which the hook
  wrapper loads. HAR unsets the `OTEL_EXPORTER_OTLP_*` variables for the hook,
  because any of them would add a second, unintended destination.
- **Spool behaviour in otel-hook 0.9.0.** A full spool drops its oldest batches
  instead of refusing new ones (default bounds: 16 MiB, 72 hours and 500 batches per
  destination). A batch rejected with a non-retryable status (anything but `408`,
  `429`, `500`, `502`, `503` and `504`) is dropped instead of spooled, so it does not
  block the queue. Hook events that close no span send no request.

See [Agent session traces](/docs/guides/otlp-backends/#agent-session-traces).

#### Mission Control no longer forwards

Earlier 2.0 prereleases had Mission Control forward what it received to your
destinations, with `~/.har/destinations` mounted into its container, and sent agent
traces straight to destinations only when Mission Control was off. Now every
producer fans out itself and Mission Control only receives and stores. The
`har-control` container no longer mounts `~/.har/destinations` or adds a
`host.docker.internal` entry, and `destination add` no longer asks you to recreate
it. Run `har control up` after upgrading so the container runs the current image: an
older, forwarding Mission Control would send your destinations a second copy of
each agent trace. The CLI marks the verification traces it sends Mission Control
with `x-har-otlp-forward: skip`, so those are never doubled.

To try an unreleased otel-hook build, set `HAR_OTEL_HOOKS_PACKAGE` to any spec your
package manager accepts (a version, an absolute `.tgz` path) before `har telemetry on`.

**Claude Code hooks don't inherit `OTEL_*`.** Since Claude Code 2.1.128, Claude Code
removes every `OTEL_*` variable from the hooks it runs, so otel-hook would see no
`OTEL_RESOURCE_ATTRIBUTES` and export sessions without `session.id`, `factory.*` or
`vcs.*`. HAR therefore also writes the same profile to `.env.agent.<id>` as
`HAR_RESOURCE_ATTRIBUTES`, and the hook wrapper restores `OTEL_RESOURCE_ATTRIBUTES`
from it when the variable arrives empty, before it drops `factory.local.*` when
Mission Control is not a destination. This applies with and without Mission
Control. An
agent started outside a HAR slot has no `HAR_RESOURCE_ATTRIBUTES`, and its hooks
behave as before. Slots launched before this change keep their old agent env file:
relaunch the slot to get the new variable.

## Everything else is unchanged

- No command, flag, config key or MCP tool was renamed or removed. MCP output
  schemas only gained optional fields (for example `proof` on
  `har_run_verification`), and `har_doctor` gained a `telemetry-destinations`
  check that only ever warns. `har telemetry destination flush` is new.
- HQ sync payloads and Mission Control's OTLP receivers keep their shapes. Only the
  attribute keys inside the synced event and span `attributes` maps change, as in
  the table above. `/api/sync` gains one optional top-level collection,
  `verificationRuns` (each run with its stages), which receivers that don't know it
  ignore. `/api/otel` bodies are unchanged.
- Proofs and telemetry are fail-open: a missing `git-factory`, a notes error or an
  unreachable destination never blocks verify, a commit or a launch. The commit
  gate is unchanged.

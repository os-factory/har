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
command, flag, config key and Mission Control route still works with the same
shape, except that `har control sync` no longer sends to HAR HQ
([see below](#har-control-sync-no-longer-sends-to-har-hq)).

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
  copy to Mission Control, which stores it as a verification run,
  and one to every destination subscribed to `traces`. A copy that was not taken is
  queued for that receiver in `~/.har/spool/traces` and retried at the next verify or
  launch, or `har telemetry destination flush`, so each receiver gets each trace
  exactly once. See
  [How verification traces are delivered](/docs/guides/otlp-backends/#how-verification-traces-are-delivered).
- **Semantic-convention attributes.** Agent sessions and verification traces carry
  `factory.*`, `vcs.*`, `cicd.*` and `gen_ai.*` attributes from the Factory Commits
  [telemetry profile](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md),
  in place of the `har.*` ones (see [Removed telemetry attributes](#removed-telemetry-attributes)).
- **One destination list.** Everything HAR sends — OTLP signals, records, proofs and
  evidence — goes to the entries of one list, `~/.har/destinations/destinations.json`:
  `mission-control`, `hq`, `git-notes`, `otlp` and `langfuse` presets, each saying
  what it accepts. otel-hook gets one `exporter.destinations[]` entry per destination,
  with the keys in a `0600` file. Without Mission Control the list simply has no
  enabled `mission-control` entry. A prerelease `telemetry.json` is migrated on first
  read. See [Agent hooks need otel-hook 0.12.0](#agent-hooks-need-otel-hook-0120).
- **Records go straight to every receiver.** The CLI sends work units, attempts,
  session segments, factory runs, stage results, commit bindings, proofs and stage
  evidence to Mission Control and HAR HQ directly (ingest v2), each through its own
  retry queue in `~/.har/queue/<destination>/`. Every `har` command drains what is
  due; `har telemetry flush` sends everything now.
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
  The trace id is `sha256("factory-run:" + run id)`, first 32 hex characters, as the
  Factory Commits telemetry profile derives it (2.0.0-next prereleases hashed
  `"har-verify:" + id`), and the `Factory-Run` trailer carries it:
  `Factory-Run: <run-id>; trace=<trace-id>`.
  Proofs need `git-factory` from `@osfactory/factory-proof` 0.2.0 or newer, and are
  always `self-reported`: they say what this checkout reports, not that an
  independent runner checked it.
  See [Record Factory Commits proofs](/docs/guides/factory-commits/).

## What changed by default

**Proofs are produced locally when `git factory` is installed; notes are opt-in.**
When `HAR_FACTORY_PROOF` is not set in `.har/harness.env`, the mode is now `notes`:

- with `git-factory` on `PATH` (or `HAR_FACTORY_PROOF_BIN`), each full verify
  writes an attestation next to the validation record, and the CLI sends it to every
  destination that takes proofs (Mission Control, HAR HQ);
- **factory notes are opt-in.** A note is one more proof destination: the
  `post-commit` hook adds the attestation to the new commit's note in
  `refs/notes/factory` only with a `git-notes` destination
  (`har telemetry destination add git-notes --preset git-notes`) or an explicit
  `HAR_FACTORY_PROOF=notes` / `notes+trailers` in `harness.env`. Notes stay local:
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

### `har control sync` no longer sends to HAR HQ

In 1.x, HAR HQ received a copy of what Mission Control held: `har control sync`
read it back from Mission Control and posted it to the connected org, so HQ got
nothing while Mission Control was down. In 2.0 `har control sync` sends to local
Mission Control only (or to HAR Cloud with `--cloud`). The CLI and the agent hook
send records, proofs, evidence and telemetry to every destination directly, HAR HQ
included; Mission Control forwards nothing. To keep sending to HQ, add it as a
destination once:

```bash
har hq connect                       # if not connected yet
har telemetry destination add hq
```

`har hq connect`, `har hq list`, `har hq disconnect` and repository attachment work
as before; they decide which org and which repositories HQ receives.
`HAR_SYNC_ALLOW_USAGE_VIOLATIONS` is gone with the HQ leg.

### `har control sync` sends only registration and slots

`har control sync` no longer posts runs, work units, validations, validation and
commit bindings, session bindings, usage, usage observations or session events
to Mission Control's `/api/repos/<id>/…` routes, and Mission Control 2.0 no
longer has those routes. They reach Mission Control as ingest v2 records and
OTLP, like any receiver. Sync keeps registering repositories and sending the
live slot view. `--full` (resend every run) is gone, and so is the harvest of
local Claude Code and Codex transcripts and rollouts: usage comes from otel-hook
only.

### Claude Code usage and trajectory come from otel-hook only

HAR no longer turns on Claude Code's native OpenTelemetry export. On upgrade it
removes the keys earlier versions wrote to the `env` block of
`~/.claude/settings.json` (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`; a key you
changed since is left alone), and registers the Claude Code hook with
`--claude-transcript-usage --logs --metrics`. Every receiver, HAR HQ included,
gets the same Claude Code traces, logs and metrics from otel-hook: one
generation per turn and one per subagent run, priced by the receiver, and the
trajectory from its event records. Run `har telemetry install-hooks` (or launch
a slot) to apply it, then start a new Claude Code session.

At the `usage` level the hook now runs too: it is the only source of agent usage.
It sends its spans and token metrics, and no event records or text.

## Privacy defaults

What a default user sends to a third party, in one sentence: nothing until a
destination is added, and then verification spans and agent session spans, without
account identity, prompt, reply and tool text, or local paths.

| Data | Sent by default? | Opt in with |
|---|---|---|
| Absolute local paths (every `factory.local.*` key, `process.cwd`, `code.filepath`, …) | No, for every destination, Mission Control included | `--include-local-paths` (agent spans keep them only when every destination opts in) |
| Account identity (`user.email`, `user.account_uuid`, `user.id`, `organization.id`, …) | No: Claude Code's native telemetry, which carries it, is not turned on | `--include-account-identity` |
| Logs (at the `full` level they carry prompts, replies and tool input/output) | No, no preset subscribes to logs | `--signals traces,metrics,logs` |
| otel-hook metrics (token counts per model, tool calls) | Only to destinations that subscribe to `metrics` | `--signals …,metrics` |

**Local paths are stripped everywhere.** Prereleases kept `factory.local.*` in agent
spans while Mission Control was a destination (#519), because Mission Control
attributed sessions by path. Work identity is now stamped from the session context,
so one agent hook process sends a Resource without local paths unless every
destination, Mission Control included, has `--include-local-paths`.

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
machine-local facts. The CLI strips every `factory.local.*` key from what it sends a
destination, and agent spans leave them out, unless the destination (for agent
spans: every destination) was added with `--include-local-paths`.

The agent env file (`.env.agent.<id>`) no longer sets `HAR_SESSION_KEY`: the
session key travels only as `session.id` in `OTEL_RESOURCE_ATTRIBUTES`. That
variable no longer carries work identity (`factory.work_unit.id`,
`factory.work_unit.source`, `factory.attempt.id`, `factory.slot.id`): otel-hook
stamps them from the session context HAR writes in `~/.har/sessions`, so telemetry
outside any segment (before launch, after complete) carries none.
`HAR_WORK_UNIT_ID`, `HAR_ATTEMPT_ID` and `HAR_CONTROL_API_URL` are unchanged.

### Agent hooks (`@osfactory/otel-hook`)

HAR 2.0 installs `@osfactory/otel-hook@0.12.0`. HAR replaces an older installed copy
on the next `har env launch` or `har telemetry on`.

#### Agent hooks need otel-hook 0.12.0

- **Work identity comes from the session context (0.12.0).** HAR sets
  `sessionContext.dir` in the hook config to `~/.har/sessions` (or
  `HAR_SESSIONS_DIR`); otel-hook stamps the segment in force on every span, log record
  and metric point. It is set in the config file, never through `OTEL_*` variables,
  which Claude Code strips from hooks.
- **Metrics and Claude Code usage.** Each destination's `signals`, `metrics`
  included (0.11.0), go into its entry; `exporter.metrics.includeSessionId` is one
  setting for every destination (`--no-include-session-id` on any destination turns
  it off). `providers.claudeCode.readTranscriptUsage: true` (0.10.0) gives Claude
  Code sessions token counts read from the transcript at `Stop`.
- **Older copies.** HAR writes only the keys the installed otel-hook understands.
  Before 0.9.0 it sends agent traces to Mission Control only, and
  `har telemetry status` names the version it needs.
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
package manager accepts (a version, an absolute `.tgz` path, a directory) before
`har telemetry on`.

**Claude Code hooks don't inherit `OTEL_*`.** Since Claude Code 2.1.128, Claude Code
removes every `OTEL_*` variable from the hooks it runs, so otel-hook would see no
`OTEL_RESOURCE_ATTRIBUTES` and export sessions without `session.id` or `vcs.*`.
HAR therefore also writes the same profile to `.env.agent.<id>` as
`HAR_RESOURCE_ATTRIBUTES`, and the hook wrapper restores `OTEL_RESOURCE_ATTRIBUTES`
from it when the variable arrives empty, before it drops `factory.local.*` unless
every destination opted in to local paths. This applies with and without Mission
Control. An
agent started outside a HAR slot has no `HAR_RESOURCE_ATTRIBUTES`, and its hooks
behave as before. Slots launched before this change keep their old agent env file:
relaunch the slot to get the new variable.

## Everything else is unchanged

- No command, flag, config key or MCP tool was renamed or removed. MCP output
  schemas only gained optional fields (for example `proof` on
  `har_run_verification`), and `har_doctor` gained `telemetry-destinations` and
  `ingest-destinations` checks that only ever warn. `har telemetry flush` and
  `har telemetry destination flush` are new.
- Mission Control's OTLP receivers keep their shapes. Only the attribute keys
  inside the event and span `attributes` maps change, as in the table above.
- Proofs and telemetry are fail-open: a missing `git-factory`, a notes error or an
  unreachable destination never blocks verify, a commit or a launch. The commit
  gate is unchanged.

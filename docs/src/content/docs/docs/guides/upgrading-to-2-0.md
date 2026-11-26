---
# STABLE URL: https://harproject.dev/docs/guides/upgrading-to-2-0/
# Receivers put this URL in the `Link: <…>; rel="deprecation"` header of their 1.x
# endpoints, and 1.x CLIs print it. Never rename or move this file, never change
# its slug, and never add a redirect from it (docs/check-drift.mjs enforces this).
title: Upgrading to 2.0
description: What HAR 2.0 changes, what the upgrade does by itself, what to run, what is no longer produced, how to roll back, and how to troubleshoot.
---

HAR 2.0 makes HAR a producer of open standards: standard OpenTelemetry that any
OTLP backend can read, and [Factory Commits](https://github.com/os-factory/factory-commits)
proofs recorded in git. Both are correlated by the same keys: work unit, attempt,
factory run, git tree, commit and trace.

The major version marks these breaks:

- **the removal of every `har.*` telemetry attribute** in favor of OpenTelemetry
  semantic-convention and `factory.*` names
  ([removed attributes](#removed-telemetry-attributes));
- **one destination list, and records sent directly to every receiver** (ingest
  v2): Mission Control and HAR HQ no longer relay for each other, and
  `har control sync` no longer sends to HAR HQ
  ([see below](#har-control-sync-no-longer-sends-to-har-hq));
- **Claude Code usage and trajectory come from otel-hook only**: HAR no longer
  turns on Claude Code's native telemetry
  ([see below](#claude-code-usage-and-trajectory-come-from-otel-hook-only));
- **Mission Control 2.0 stores the v2 data model**: it migrates its database in
  place on first start, keeps a backup, and no longer has the 1.x
  `/api/repos/<id>/…` record routes;
- **factory notes are opt-in** ([what changed by default](#what-changed-by-default)).

Commands, MCP tools and config keys keep their names. The few flags and variables
that went away are listed in [What 2.0 no longer produces](#what-20-no-longer-produces).

## Upgrade checklist

Upgrade the CLI and Mission Control together: Mission Control 2.0 reads only the
2.0 attribute names and records.

```bash
npm install -g @osfactory/har@latest   # the CLI
har control up                         # Mission Control on the same version; migrates its database
har telemetry install-hooks            # re-register the agent hooks with otel-hook
har env maintain                       # in each repository with a .har/ harness
har env doctor                         # destinations, queues, receivers
har env verify 1 --full
```

Then start new agent sessions: a Claude Code session that was already running
keeps the hook settings it started with.

Optional, depending on what you want:

```bash
# Record prompts, replies and tool input/output (the full trajectory) locally
har telemetry on --level full

# Send chosen repositories to HAR HQ (the upgrade logs a 1.x login out; see below)
har hq connect

# Write each proof as a git note on the verified commit (opt-in)
har telemetry destination add git-notes --preset git-notes

# Send a copy to Langfuse or any OTLP backend
har telemetry destination add langfuse --preset langfuse --host <url> --public-key <pk> --secret-key <sk>
har telemetry destination add collector --preset otlp --endpoint <base OTLP/HTTP URL>
```

## What happens automatically

You do not need to do anything for these; each happens once, on the first 2.0
command that needs it.

- **HAR HQ keeps receiving.** A machine conn- **You are logged out of HAR HQ.** A machine logged in to HAR HQ with 1.x is
  logged out on the first 2.0 command, with one notice line, and nothing is sent to
  HAR HQ until you log in again with `har hq connect` and choose repositories and a
  scope. Your 1.x repositories and trajectory choice are only pre-selected at that
  login. Details in
  [HAR HQ is opt-in per repository](#har-hq-is-opt-in-per-repository-the-upgrade-logs-you-out).
are removed.** The next time HAR
  configures the agent hooks (`har telemetry install-hooks`, `har telemetry on`,
  a slot launch, or a destination change), it deletes the
  `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_*` keys that an earlier HAR wrote into
  `~/.claude/settings.json`. It removes only the keys it recorded writing, and only
  while they still hold the value it wrote: a key you set or changed yourself is
  left alone.
- **otel-hook is upgraded.** HAR installs `@osfactory/otel-hook@0.13.2` in place of
  an older copy on the next launch or `har telemetry on`, and registers the Claude
  Code hook with `--claude-transcript-usage --logs --metrics` and the Codex hook
  with `--codex-rollout-usage`.
- **Verify runs the packaged stage runner.** A repository set up by 1.x has a copy
  of the stage runner committed in `.har/lib/verify-runner.mjs`; 2.0 no longer runs
  it (it captures no stage logs), and runs the one in the package instead, unless
  you ejected the runtime (`har env eject`). `har env maintain` deletes the stock
  copy (commit the deletion); `har env doctor` points at a copy you edited.
  `har env maintain` leaves your `verificationStages` as they are.
- **Mission Control migrates its database in place.** On its first start, a
  Mission Control 2.0 container that finds a 1.x database snapshots it to
  `har_control.db.v1-backup` (in the `har_control_data` volume, next to
  `har_control.db`), builds the v2 database next to it, copies every row across and
  swaps it in with one rename. Nothing is deleted: the 1.x data stays in the
  backup, and a start that is interrupted before the swap leaves the database
  untouched and starts over. If a backup already exists, the new one gets a
  timestamp suffix. See [Rolling back](#rolling-back).
- **A prerelease `telemetry.json`** (2.0.0-next) is migrated to the destination
  list on first read.

## What's new in 2.0

This section is the curated summary of the release; the GitHub release notes link
here. The generated list of every change is in the
[changelog](https://github.com/os-factory/har/blob/main/CHANGELOG.md).

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
  due; `har telemetry flush` sends everything now. Stage evidence (each stage's log
  and the files it wrote under `.har/artifacts/`) is sent only after a passing full
  verify.
- **Work identity from the session context.** HAR writes which work unit, attempt
  and slot each agent session is working on to `~/.har/sessions`, as time segments,
  and otel-hook stamps the segment in force on every span, log record and metric
  point. A session that joins or leaves a slot is attributed correctly from that
  moment, and telemetry outside any segment carries no work identity.
- **Trajectory from otel-hook.** Every receiver, HAR HQ included, builds the agent
  trajectory (steps, tool calls, subagents) from otel-hook's log records, and books
  usage from its generation spans.
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
included (only for the repositories you chose); Mission Control forwards nothing.

### HAR HQ is opt-in per repository: the upgrade logs you out

In 1.x a HAR HQ login sent every attached repository there. In 2.0 HAR HQ receives
only the repositories you choose, each at the scope you choose. So the first 2.0
command on a machine logged in to HAR HQ logs it out: the stored login and its tokens
are removed, nothing is sent to HAR HQ, and one line says so:

```text
[har] HAR 2.0 sends to HAR HQ only for repositories you choose. Run `har hq connect` to log in again.
```

This happens once; a later login is never logged out again. Mission Control and
your other destinations are not affected. Until you log in, `har hq status` and
`har env doctor` print one informational line about it (never a warning, and
nothing ever prompts on agent paths).

Log in again and choose:

```bash
har hq connect
```

On a terminal, after the login it asks **which repositories** HAR HQ receives (this
repository and the ones attached in 1.x are pre-selected, the other registered
repositories are listed) and **at which scope**, in onboarding's words — one scope
for all of them, or one per repository:

| Scope | HAR HQ receives |
|-------|-----------------|
| `off` | nothing |
| `usage` | records, proofs, verification evidence, tokens and cost (agent spans and metrics, no event records) |
| `outline` | `usage` plus every step and its timing, no text |
| `full` | `outline` plus prompts, replies and tool output, as you choose: `none`, `redacted` (secrets replaced), `masked` (every character masked) or `raw` |

The scope pre-selected is what 1.x sent: the outline, or the full trajectory with raw
text when you forwarded it. Without a terminal (CI, agents), pass the choice:

```bash
har hq connect --api-key "$HAR_PORTAL_TOKEN" --repo . --scope usage --yes
har hq connect --repo . --repo ../web --scope full --content redacted --yes
```

Without `--scope`, a non-interactive `connect` only logs in, chooses nothing, and
prints the command that does. Change the choice any time with
`har hq repos add <path|url>… --scope …`, `har hq repos remove <path|url>…` and
`har hq repos` (or `har hq status`). A repository you register later is not sent
until you add it. The local telemetry level still caps every destination: at
`outline`, a repository at the `full` scope gets the outline.

The `hq` destination carries the choice (its `repositories`); agent telemetry is
filtered per record by otel-hook from the repository it names
(`vcs.repository.url.full`), so a repository without an `origin` remote sends HAR
HQ records and verification only. An otel-hook that cannot filter by repository
gets no `hq` entry at all. `HAR_PORTAL_TOKEN` alone is not logged out, but sends
nothing either until repositories are chosen. `har control trajectory` only points
to `har hq repos` now.
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
`--claude-transcript-usage --logs --metrics`, and the Codex hook with
`--codex-rollout-usage` (each turn's tokens, read from the session rollout at
`Stop`). `har telemetry status` lists a hook registered without them. Every receiver, HAR HQ included,
gets the same Claude Code traces, logs and metrics from otel-hook: one
generation per turn and one per subagent run, priced by the receiver, and the
trajectory from its event records. Run `har telemetry install-hooks` (or launch
a slot) to apply it, then start a new Claude Code session.

At the `usage` level the hook now runs too: it is the only source of agent usage.
It sends its spans and token metrics, and no event records or text.

## Privacy defaults

What a default user sends to a third-party OTLP backend (an `otlp` or `langfuse`
destination), in one sentence: nothing until such a destination is added, and then
verification spans and agent session spans, without account identity, prompt,
reply and tool text, or local paths.

| Data | Sent by default? | Opt in with |
|---|---|---|
| Absolute local paths (every `factory.local.*` key, `process.cwd`, `code.filepath`, …) | No, for every destination, Mission Control included | `--include-local-paths` (agent spans keep them only when every destination opts in) |
| Account identity (`user.email`, `user.account_uuid`, `user.id`, `organization.id`, …) | No: Claude Code's native telemetry, which carries it, is not turned on | `--include-account-identity` |
| Logs (at the `full` level they carry prompts, replies and tool input/output) | Not to `otlp` or `langfuse` destinations: neither preset subscribes to logs. Mission Control takes them, and an `hq` destination takes them when `logs` is in its signals | `--signals traces,metrics,logs` |
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
| `har.harvest.truncated`, `har.harvest.dropped_events`, `har.harvest.total_events` | removed with the transcript harvest ([no longer produced](#what-20-no-longer-produced)); 2.0.0-next prereleases emitted them as `factory.usage.harvest.*` |
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

HAR 2.0 installs `@osfactory/otel-hook@0.14.0` (0.12.0 or later is required; 0.14.0 or later to send agent telemetry to HAR HQ). HAR replaces an older installed copy
on the next `har env launch` or `har telemetry on`.

#### Agent hooks need otel-hook 0.12.0

- **Work identity comes from the session context (0.12.0).** HAR sets
  `sessionContext.dir` in the hook config to `~/.har/sessions` (or
  `HAR_SESSIONS_DIR`); otel-hook stamps the segment in force on every span, log record
  and metric point. It is set in the config file, never through `OTEL_*` variables,
  which Claude Code strips from hooks.
- **Metrics and Claude Code usage.** Each destination's `signals`, `metrics`
  included (0.11.0), go into its entry; `exporter.metrics.includeSessionId` is one
  setting for every unscoped destination (`--no-include-session-id` on any of them
  turns it off); a scoped destination (HAR HQ) carries its own in its scopes.
- **Repository scopes.** The `hq` destination is written with otel-hook's per-destination
  `scopes` (repositories, signals, content mode per scope), so HAR HQ gets only the
  repositories chosen for it. The otel-hook release HAR pins does not have scopes yet:
  until it does, HAR leaves `hq` out of the hook config (records and verification
  still go there; agent telemetry does not). `providers.claudeCode.readTranscriptUsage: true` (0.10.0) gives Claude
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

## What 2.0 no longer produces

- **The offline usage harvest.** 1.x `har control sync` read Claude Code
  transcripts and Codex rollouts from disk and posted the usage it found. 2.0
  books agent usage only from otel-hook, live: a session that ran without the hook
  has no usage. The `factory.usage.harvest.*` attributes are gone with it.
- **A per-request Claude Code breakdown.** Claude Code's native `api_request`
  events and `claude_code.*` metrics are no longer turned on, and Mission Control
  ignores them if they arrive. Claude Code usage is one otel-hook generation per
  turn and one per subagent run.
- **Launch, teardown and run-stage records at the receivers.** HAR still writes
  every run to `.har/runs/` locally. Receivers get the slot's work unit, attempt and
  session segments, and one factory run per verified tree with its stage results;
  the separate run records of a launch or a teardown no longer leave the machine.
- **Changed files on a verify.** A v2 factory run carries no changed-file list, so
  Mission Control shows none for verifies recorded after the upgrade. Factory runs
  migrated from 1.x keep theirs, and the local validation record still has it.
- **Relaying between receivers.** `har control sync` no longer posts records to
  Mission Control or forwards anything to HAR HQ, and Mission Control 2.0 forwards
  nothing. `har control sync --full` and `HAR_SYNC_ALLOW_USAGE_VIOLATIONS` are gone.
- **Factory notes by default.** A note is written only with a `git-notes`
  destination or an explicit `HAR_FACTORY_PROOF=notes…` (see
  [What changed by default](#what-changed-by-default)).

## HAR HQ: 1.x endpoints and their sunset

HAR 2.0 speaks only the v2 ingest contract. HAR HQ runs the v2 endpoints next to
the 1.x ones, so a 1.x CLI keeps working while you upgrade:

1. **At 2.0.0** the v2 endpoints are live before the 2.0.0 CLI is released. The
   1.x endpoints are frozen (no new fields) and answer with a `Deprecation`
   header ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)), a `Sunset` header
   ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) and a
   `Link: <https://harproject.dev/docs/guides/upgrading-to-2-0/>; rel="deprecation"`
   header pointing at this page.
2. **The sunset** comes no earlier than six months after 2.0.0, and only once 1.x
   traffic is low. The 1.x endpoints then answer `410 Gone` with the upgrade
   command. Data sent through them stays readable.

Mission Control has no such period: it ships with the CLI, in the same version,
and migrates in place.

## Rolling back

To go back to 1.x, restore the Mission Control backup and reinstall the 1.x CLI.
Records sent to Mission Control after the upgrade are not in the backup. If the
volume holds more than one backup (`har_control.db.v1-backup-<timestamp>`), use the
newest.

```bash
npm install -g @osfactory/har@1
har control down
docker run --rm -v har_control_data:/data alpine sh -c \
  'cd /data && mv har_control.db har_control.db.v2 && cp har_control.db.v1-backup har_control.db'
har control up          # the 1.x CLI starts the 1.x Mission Control image
har telemetry on        # re-registers the 1.x agent hooks
```

Keep the 1.x CLI while you use the restored database: a 2.0 CLI moves Mission
Control to its own image, which migrates the database again.

## Troubleshooting

Start with `har env doctor` (MCP: `har_doctor`) and `har telemetry status`. Their
destination checks only ever warn: a receiver that is down never blocks verify, a
commit or a launch.

| Symptom | What to check | Fix |
|---|---|---|
| `har hq status` or doctor: "Logged out of HAR HQ by the upgrade to 2.0", or "repositories: none chosen" | 2.0 sends to HAR HQ only for repositories you choose | `har hq connect`, then `har hq repos add <repo> --scope usage` (scopes: off, usage, outline, full) |
| doctor `ingest-destinations`: the receiver does not support ingest v2 | Mission Control (or another receiver) still runs a 1.x version | `har control up`. Records stay queued until the receiver answers v2 |
| doctor `ingest-destinations`: entries queued, or a last failure | The receiver is down or rejected the key. Unknown routes (404, 405, 501) and rejected keys (401, 403) are retried, so nothing is lost before a receiver is upgraded | Fix the receiver or the key, then `har telemetry flush`. Every `har` command also drains what is due |
| doctor `ingest-destinations`: entries in `dead/` | The receiver rejected a batch as invalid, or it was older than 14 days | Inspect `~/.har/queue/<destination>/dead/`; those entries are not retried |
| doctor `telemetry-destinations`: batches queued or dropped | An OTLP backend is unreachable | Check the backend, then `har telemetry destination flush` |
| No Claude Code usage or trajectory | The Claude Code hook was registered by 1.x, or the session started before the upgrade | `har telemetry install-hooks`, then start a new Claude Code session. `har telemetry status` names the otel-hook version it needs |
| A dashboard or alert matches nothing | It filters on a `har.*` attribute | Use the [2.0 names](#removed-telemetry-attributes) |

## Everything else is unchanged

- No command, config key or MCP tool was renamed or removed, and the only
  flags and variables removed are those under
  [What 2.0 no longer produces](#what-20-no-longer-produces). MCP output
  schemas only gained optional fields (for example `proof` on
  `har_run_verification`), and `har_doctor` gained `telemetry-destinations` and
  `ingest-destinations` checks that only ever warn. `har telemetry flush` and
  `har telemetry destination flush` are new.
- Mission Control's OTLP receivers keep their shapes. Only the attribute keys
  inside the event and span `attributes` maps change, as in the table above.
- Proofs and telemetry are fail-open: a missing `git-factory`, a notes error or an
  unreachable destination never blocks verify, a commit or a launch. The commit
  gate is unchanged.

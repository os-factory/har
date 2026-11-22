---
title: Upgrading to 2.0
description: What HAR 2.0 adds, the one default it changes, what it sends by default, and what is deprecated. Nothing is removed.
---

HAR 2.0 makes HAR a producer of open standards: standard OpenTelemetry that any
OTLP backend can read, and [Factory Commits](https://github.com/os-factory/factory-commits)
proofs recorded in git. Both are correlated by the same keys: work unit, attempt,
factory run, git tree, commit and trace.

The major version marks one changed default. **Nothing is removed**: every 1.x
command, flag, config key, `har.*` telemetry attribute, HQ sync payload and Mission
Control route still works with the same shape.

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
  with one task span per stage to every destination subscribed to `traces`. They
  carry ids, results and timings only.
- **Semantic-convention attributes.** Agent sessions and verification traces carry
  `factory.*`, `vcs.*`, `cicd.*` and `gen_ai.*` attributes from the Factory Commits
  [telemetry profile](https://github.com/os-factory/factory-commits/blob/main/profiles/telemetry.md),
  next to the existing `har.*` ones (see [Deprecations](#deprecations)).
- **Factory Commits proofs.** A full verify becomes an in-toto `factory-run`
  statement for the exact verified tree. The commit of that tree gets it as a note
  in `refs/notes/factory`, and optionally as trailers. `har proof show|verify`
  (MCP: `har_proof_show`, `har_proof_verify`) reads them. The predicate carries the
  verification trace id when that trace is exported, so a proof leads to its trace.
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
| Absolute local paths (`har.repo_path`, `har.work_dir`, `process.cwd`, `code.filepath`, …) | No, Mission Control strips them | `--include-local-paths` |
| Account identity (`user.email`, `user.account_uuid`, `user.id`, `organization.id`, …) | No, Mission Control strips them | `--include-account-identity` |
| Logs (at the `full` level they carry prompts, replies and tool input/output) | No, no preset subscribes to logs | `--signals traces,metrics,logs` |

The flags go on `har telemetry destination add`. Mission Control keeps everything
locally as before. The full lists of stripped attributes are in
[Send telemetry to any OTLP backend](/docs/guides/otlp-backends/#privacy). Proofs
never contain prompts, stage logs, absolute paths or work unit titles.

## Deprecations

The `har.*` telemetry attributes are still emitted with the same values. They are
deprecated, and removal is planned for a future major version. New dashboards and
queries should use the replacement names:

| Deprecated | Replacement |
|---|---|
| `har.work_unit_id` | `factory.work_unit.id` (and `factory.work_unit.source` for the tracker) |
| `har.attempt_id` | `factory.attempt.id` |
| `har.branch` | `vcs.ref.head.name` |
| `har.session_key` | `session.id` on session spans |
| `har.agent_id` | none yet: the slot number has no standard name |
| `har.suffix` | none yet |
| `har.repo_path`, `har.work_dir` | none: local paths, never forwarded by default |

`factory.producer.name` (`har`), `factory.producer.version` and
`vcs.repository.url.full` have no `har.*` counterpart.

## Nothing removed

- No command, flag, config key or MCP tool was renamed or removed. MCP output
  schemas only gained optional fields (for example `proof` on
  `har_run_verification`).
- HQ sync payloads and Mission Control's OTLP receivers keep their shapes.
- Proofs and telemetry are fail-open: a missing `git-factory`, a notes error or an
  unreachable destination never blocks verify, a commit or a launch. The commit
  gate is unchanged.

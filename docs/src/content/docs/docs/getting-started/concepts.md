---
title: Core concepts
description: Harnesses, slots, worktrees, stages, runs, and validations.
---

## Harness

The `.har/` directory is the repository's operating contract — a configuration
surface, not a copy of HAR's runtime. `harness.env` holds schema-validated
configuration; `stages.json` and `.har/stages/` define verification; `.har/hooks/`
and `.har/plugins/` hold lifecycle and larger extensions; the `*.sh` files are
thin shims over the packaged runtime; Markdown files tell agents how to use the
adapted workflow.

The project owns this directory. HAR can scaffold and maintain it, but teams can
review and modify it like normal source code.

## Agent slot

A slot is a numbered, reusable lane for one active task. The allowed range comes
from `agentSlots` in `.har/stages.json` and matching settings in `harness.env`.
Web profiles can assign each lane isolated ports and a per-slot database.

A slot is not a permanent environment. Every normal launch creates a fresh session.

## Session worktree

By default, launch creates:

- a branch named from the base branch, commit, agent id, and random suffix;
- a Git worktree outside the main checkout;
- `.env.agent.<id>` with resolved paths, ports, and service settings;
- `.har/slots/agent-<id>.json` as the source of truth for session state.

The worktree is where code is edited and tested. Teardown removes it while retaining
the branch. Gitignored files inside a removed worktree are ephemeral.

## Stage

A stage is a project-defined operation with an id, kind, command, accepted
arguments, and optional artifacts. Supported kinds are `setup`, `launch`, `verify`,
`test`, `inspect`, `reset`, `teardown`, and `custom`.

HAR does not need to understand the underlying tool. `browser-e2e`,
`migration-check`, and `load-smoke` can all be ordinary stages.

## Run record

CLI and MCP executions persist normalized JSON records under:

```text
.har/runs/YYYY-MM-DD/HH-mm-ss_<stage>_agent-<id>.json
```

A record includes the repository, stage, status, timing, trigger (`cli`, `mcp`, or
`script`), result, command, and active work directory when available.

## Artifact

Artifacts are declared outputs such as files, directories, logs, reports,
screenshots, traces, videos, and URLs. They normally live under `.har/artifacts/`
and are discoverable through MCP and Mission Control.

## Validation and change batch

A full verify hashes the complete working-tree state and records a validation under
`.har/validations/`. This binds "passed" to exact content, not merely a branch name.
Mission Control groups those states into change batches and can associate a later
commit with the validation.

## Commit gate

The optional Git hook gate compares the staged tree with a successful full
validation. Depending on configuration, an unverified batch is blocked or warned
about, in agent worktrees only or in every checkout.

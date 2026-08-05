---
title: FAQ
description: Common questions about HAR's purpose and operating model.
---

## Is HAR a coding agent?

No. HAR gives agents a stable, project-owned way to operate a repository. Cursor,
Claude Code, Codex, and other clients remain responsible for reasoning and code edits.

## Does HAR replace CI/CD?

No. It moves a reproducible version of the important workflow earlier into local
agent development. CI remains the merge and deployment authority.

## Does HAR replace my issue tracker or coding methodology?

No. Humans, trackers, and skill packs own intent, decomposition, TDD, debugging, and
review. HAR can bind a stable work identifier to one or more isolated attempts and
preserve execution plus exact-tree verification evidence. Mission Control derives
operational state from that evidence; it does not copy mutable tracker workflows.

## Why shell scripts instead of hidden CLI logic?

Real repositories have unique services, setup steps, and safety rules. Checked-in
scripts are reviewable, versioned, and usable without HAR. The CLI provides a stable
control plane over that project-owned behavior.

## Why use worktrees?

They isolate concurrent tasks, preserve a clean main checkout, give each session a
branch, and let teardown remove runtime state without deleting reviewable work.

## Can a human use HAR?

Yes. CLI commands and generated scripts are first-class human interfaces. MCP adds
structured agent access to the same core.

## What is included in the open-source core?

The `har` CLI, editable `.har/` boilerplate, local/self-hosted execution, a generic
stage/result contract, an MCP server, plus logs, status, artifacts, and preview URL
discovery. The repo-owned `.har/` directory remains the runtime contract.

## What is a stage?

A project-defined operation HAR can run and report in a normalized way. Kinds are
`setup`, `launch`, `verify`, `test`, `inspect`, `reset`, `teardown`, and `custom`.
Ids such as `browser-e2e` or `migration-check` are ordinary stages — not hardcoded
product features.

## Is Playwright built into HAR?

No. It is an optional plugin (`har env add-plugin playwright`). The resulting
`browser-e2e` stage is an ordinary project stage, just like a migration check or
load smoke test. Migrations, accessibility, and load checks follow the same pattern:
add stages when they matter.

## Where does local data live?

Slot registry, run history, validations, artifacts, and state live under `.har/`
and are normally gitignored. Active worktree locations are recorded, not inferred.

## Why are Codex prompts global?

Codex CLI does not support repository-local custom prompt files. HAR writes them to
`~/.codex/prompts/`; each developer installs them once. Repository `AGENTS.md` is the
project-specific harness contract Codex auto-loads (HAR creates or updates a managed
HAR section during init/onboard). Claude and Cursor skills stay in the
repo (`.claude/skills/`, `.cursor/commands/`). Keep `CLAUDE.md` as a thin pointer to
`AGENTS.md` — do not duplicate the full workflow there.

## What if launch fails halfway?

Use `har env recover <id>` or launch with `--resume`. Recovery preserves the created
worktree and environment. Only teardown/relaunch the slot if you intend to start over —
occupied slots always block a fresh launch.

## Can I change the generated harness?

Yes—that is the design. Adapt scripts and configuration to match the repository.
Use `har env maintain` to compare later bundled updates without wiping customization.

## What is open source versus hosted?

The CLI, MCP server, repository harness, local execution, run evidence, and Mission
Control dashboard are open source. HAR Cloud adds hosted coordination, remote runs
and previews, team policy, approvals, integrations, and auditability — not a
replacement for the portable `.har/` contract.

## How is documentation licensed?

The entire project — software and documentation — is licensed under Apache-2.0.
See the repository [LICENSE](https://github.com/os-factory/har/blob/main/LICENSE).

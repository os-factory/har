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

## Does my project own the harness, or does HAR?

The project owns its **behavior**; HAR owns the machinery. Everything that makes
the harness yours is checked in and readable: configuration (`harness.env`),
verification stages (`stages.json` + `.har/stages/`), lifecycle hooks
(`.har/hooks/`), and local plugins (`.har/plugins/`). That surface is smaller and
more reviewable than a vendored copy of HAR's runtime ever was — and it is what
`har env doctor` validates and drift tracking protects.

CLI and MCP are the only entry points: both run the same packaged runtime and
write the same run records. Teams that want to own the runtime itself can take
it explicitly with `har env eject` — the vendored bundle lives in
`.har/runtime/`, invoked as `node .har/runtime/har.cjs env …`.

## Why use worktrees?

They isolate concurrent tasks, preserve a clean main checkout, give each session a
branch, and let teardown remove runtime state without deleting reviewable work.

## Can a human use HAR?

Yes. CLI commands are a first-class human interface. MCP adds structured
agent access to the same core.

## What is included in the open-source core?

The `har` CLI (with the packaged harness runtime), the project-owned `.har/`
configuration surface, local/self-hosted execution, a generic stage/result
contract, an MCP server, plus logs, status, artifacts, and preview URL discovery.
The repo-owned `.har/` directory remains the project's operating contract.

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
repo (`.claude/skills/`, `.cursor/commands/`). `CLAUDE.md` holds nothing but the
line `@AGENTS.md`, so Claude Code loads the same instructions as every other agent.

## What if launch fails halfway?

Use `har env recover <id>` or launch with `--resume`. Recovery preserves the created
worktree and environment. Only teardown/relaunch the slot if you intend to start over —
occupied slots always block a fresh launch.

## Can I change the generated harness?

Yes—that is the design. Customization has four sanctioned homes: configuration
values in `harness.env`, verification steps as registered stages, lifecycle side
effects as hooks in `.har/hooks/`, and anything bigger as a local plugin in
`.har/plugins/`. `har env eject` exists for teams that want to own the runtime
scripts outright. See the
[customization contract](/docs/guides/customization/); `har env maintain` folds
in later template updates without wiping customization.

## What is open source versus hosted?

The CLI, MCP server, repository harness, local execution, run evidence, and Mission
Control dashboard are open source. HAR Cloud adds hosted coordination, remote runs
and previews, team policy, approvals, integrations, and auditability — not a
replacement for the portable `.har/` contract.

## How is documentation licensed?

The entire project — software and documentation — is licensed under Apache-2.0.
See the repository [LICENSE](https://github.com/os-factory/har/blob/main/LICENSE).

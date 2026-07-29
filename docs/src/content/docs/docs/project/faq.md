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

## Is Playwright built into HAR?

No. It is an optional plugin. The resulting `browser-e2e` stage is an
ordinary project stage, just like a migration check or load smoke test.

## Where does local data live?

Slot registry, run history, validations, artifacts, and state live under `.har/`
and are normally gitignored. Active worktree locations are recorded, not inferred.

## Why are Codex prompts global?

Codex CLI does not support repository-local custom prompt files. HAR writes them to
`~/.codex/prompts/`; each developer installs them once. Repository `AGENT.md` still
contains the project-specific harness pointers.

## What if launch fails halfway?

Use `har env recover <id>` or launch with `--resume`. Recovery preserves the created
worktree and environment. Do not replace the slot unless you intend to start over.

## Can I change the generated harness?

Yes—that is the design. Adapt scripts and configuration to match the repository.
Use `har env maintain` to compare later bundled updates without wiping customization.

## What is open source versus hosted?

The CLI, MCP server, repository harness, local execution, run evidence, and Mission
Control dashboard are open source. HAR Cloud adds hosted coordination, remote runs
and previews, team policy, approvals, integrations, and auditability.

## How is documentation licensed?

Software uses AGPL-3.0-only, written documentation uses CC BY-SA 4.0, and HAR names,
logos, and trademarks remain governed by the repository trademark policy.

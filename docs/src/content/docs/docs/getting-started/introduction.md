---
title: Introduction
description: What HAR solves and where it fits in an agent development workflow.
---

HAR is an open-source, agent-agnostic standard for building **multi-agent coding
workflows**. It makes your repository agent-ready so you can run a fleet of coding
agents in parallel, with deterministic validation gates, verifiable proof, and full
observability across every agent — without tying the repository to one model,
editor, test framework, or hosted platform.

## The problem

Launching a real application often depends on knowledge that is scattered across
README files, package scripts, shell history, and one developer's machine:

- which dependencies and infrastructure must start first;
- how ports, databases, and environment files are allocated;
- which checks define "done";
- where logs, previews, traces, and screenshots are written;
- how to clean up without destroying someone else's work.

Agents can attempt to rediscover those details on every task, but that is slow and
risky. HAR captures them once in a versioned `.har/` directory.

## The boundary

HAR provides:

- editable launch, verification, inspection, reset, and teardown scripts;
- isolated agent slots backed by fresh Git worktrees;
- a machine-readable stage and artifact registry;
- consistent CLI and MCP operations over project-specific scripts;
- persisted run history and exact-tree validation records;
- optional commit gates, agent skills, and worktree guards;
- a local Mission Control dashboard.

HAR does **not** write application code, replace CI/CD, or require a particular test
runner. Project-specific tools such as Playwright and RocketSim are optional stage
templates that compile down to the same generic stage contract.

## Who uses it

Humans can run `har env ...` from a terminal. MCP-capable agents call the equivalent
`har_*` tools. Cursor, Claude Code, and Codex users can also install managed
project workflows. All three paths execute the repository's own `.har/` scripts.

## Open source and portability

The CLI, MCP server, harness runtime, and local Mission Control are open source.
The `.har/` directory remains in your repository and is editable even if you stop
using HAR's CLI. Hosted coordination belongs to HAR Cloud; it does not replace the
portable local contract.

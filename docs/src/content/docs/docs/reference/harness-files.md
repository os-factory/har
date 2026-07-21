---
title: Harness files
description: The generated .har directory and the role of each file.
---

A profile may omit files that do not apply, but the default web harness typically
contains:

| Path | Purpose |
| --- | --- |
| `.har/README.md` | Human index and adapted operating guide |
| `.har/STAGES.md` | Stage registry, custom-stage, script-contract, and verification guide |
| `.har/manifest.json` | Generator version, profile, checksums, and managed files |
| `.har/harness.env` | Shared configuration, commands, services, ports, and limits |
| `.har/stages.json` | Machine-readable stages, artifacts, slot range, and gate policy |
| `.har/setup-infra.sh` | Start optional shared infrastructure and template state |
| `.har/preflight.sh` | Inspect launch readiness and resource conflicts |
| `.har/launch.sh` | Create a session, provision state, and start the primary app |
| `.har/verify.sh` | Quick and full verification pipeline |
| `.har/teardown.sh` | Stop processes, remove slot state, and remove worktree |
| `.har/agent-cli.sh` | Resolve a slot and run status, logs, health, exec, or database helpers |
| `.har/agent-slot.sh` | Shared slot validation and registry helpers |
| `.har/provision-toolchain.sh` | Detect/install the project ecosystem and record binaries |
| `.har/env.template` | Expanded into `.env.agent.<id>` |
| `.har/ecosystem.agent.template.cjs` | PM2 primary-app process template for web profiles |
| `.har/docker-compose.agent.yml` | Optional shared Docker services |
| `.har/CLAUDE.agent.md` | Detailed coding-agent workflow and definition of done |
| `.har/justfile` | Optional `just` shortcuts |

## Generated local state

These paths are normally gitignored:

| Path | Purpose |
| --- | --- |
| `.har/slots/agent-<id>.json` | Active session registry and source of truth for its work directory |
| `.env.agent.<id>` | Resolved per-slot environment |
| `.har/runs/` | Persisted CLI/MCP run records |
| `.har/validations/` | Exact-tree full-verification records |
| `.har/artifacts/` | Reports, logs, traces, screenshots, videos, and other stage output |
| `.har/state/` | Local harness state and registration |
| `.har/logs/` | Optional harness logs |
| `.har/maintain/` | Review bundle created during maintenance |
| `.har/ADAPT-PROMPT.md` | Current manual adaptation prompt |

Run history is written in the main checkout even when execution occurs in a session
worktree. Each record includes `workDir` so the two locations remain traceable.

## Runtime behavior belongs in scripts

`stages.json` is discovery metadata, not a second orchestration language. Put
install, process, database, health, and cleanup behavior in the shell scripts and
keep the registry aligned with what those scripts actually expose.

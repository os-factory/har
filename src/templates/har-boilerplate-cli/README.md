# .har — Agent Harness

This directory is the **agent harness** for this repository. It lets AI coding agents (Cursor, Claude Code, etc.) run the project in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/your-org/har). Run `har env maintain` when the repo stack changes.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, checksums) — do not edit |
| `harness.env` | Shared config: ports, agent slot limits, infra flags, migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Local run history written by `har` CLI/MCP (gitignore this directory) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation (reads limits from `harness.env`) |
| `setup-infra.sh` | Start shared Docker infra + create template database |
| `launch.sh` | Launch one agent slot (ports, DB clone, PM2 processes) |
| `verify.sh` | Verification pipeline (typecheck, tests, health) |
| `teardown.sh` | Tear down one agent slot |
| `agent-cli.sh` | Manage a running agent (status, logs, psql, health) |
| `attach.sh` | Attach to agent tmux session |
| `env.template` | Per-agent env vars (expanded by `launch.sh`) |
| `ecosystem.agent.template.cjs` | PM2 process definitions (expanded by `launch.sh`) |
| `docker-compose.agent.yml` | Shared infrastructure containers |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

## Quick start

```bash
# 1. Shared infrastructure (once)
./.har/setup-infra.sh

# 2. Launch agent 1
./.har/launch.sh 1

# 3. Check status
./.har/agent-cli.sh 1 status

# 4. Verify after changes
./.har/verify.sh 1

# 5. Tear down
./.har/teardown.sh 1
```

Or via the har CLI:

```bash
har env launch 1
har env verify 1
har env teardown 1
```

## For coding agents

**Start here:** read [`AGENT.md`](../AGENT.md) at the repo root for a short pointer, then [`.har/CLAUDE.agent.md`](./CLAUDE.agent.md) for full instructions.

Always use `./.har/agent-cli.sh <id> ...` for environment operations — never raw docker compose or hardcoded ports.

## Architecture

Each agent slot gets isolated ports: `BASE + (AGENT_ID × 10)`.

Configure how many slots your machine can run in parallel in `stages.json` (`agentSlots`) and `harness.env` (`HARNESS_AGENT_SLOT_MIN` / `HARNESS_AGENT_SLOT_MAX`). Keep both in sync.

| Service | Agent 1 | Agent 2 |
|---------|---------|---------|
| Frontend | 3010 | 3020 |
| API | 8010 | 8020 |

Shared infra (Postgres, MinIO, etc.) runs once on fixed ports — see `harness.env` and `docker-compose.agent.yml`.

## Maintaining this harness

When the project stack changes (new services, different test commands, new env vars):

```bash
har env maintain
```

The authoring agent updates scripts and this README. Review changes before committing.

**Do not** put runtime behavior in YAML — edit the scripts directly.

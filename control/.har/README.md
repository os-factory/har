# .har — Agent Harness

This directory is the **agent harness** for this repository. It lets AI coding agents (Cursor, Claude Code, etc.) run the project in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/your-org/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this app.** Need Mission Control live — manual testing, a browser session, screenshots? `docker compose up -d db`, then `launch` a slot; don't hand-roll dev-server startup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, checksums) — do not edit |
| `harness.env` | Shared config: ports, agent slot limits, infra flags, migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP only — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation (reads limits from `harness.env`) |
| `setup-infra.sh` | Start shared Docker infra + create template database |
| `launch.sh` | Launch one agent slot (ports, DB schema, PM2 processes) |
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
./.har/setup-infra.sh          # when Docker infra flags are on
./.har/launch.sh 1
./.har/verify.sh 1             # quick: typecheck, tests, health
./.har/verify.sh 1 --full      # done gate: + lint + browser-e2e (if Playwright stage installed)
./.har/teardown.sh 1
```

Read **`stages.json`** for registered stages and **`verificationStages`** for the expected pass set.

## Verification contract

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `verify.sh <id>` | Project checks in `verify.sh` (stops early on failure) |
| Full | `verify.sh <id> --full` | Quick steps + lint + **`browser-e2e`** when `.har/stages/browser-e2e.sh` exists |

Install Playwright stage: `har env add-stage playwright` (optional). UI changes should add or update specs under `tests/`.

## Quick start (har CLI)

```bash
har env launch 1
har env verify 1
har env teardown 1
```

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No — same scripts, no run record |
| `har env …` / MCP | Yes — under main checkout `.har/runs/YYYY-MM-DD/` |

With git worktree slots, verification runs code in the worktree but run JSON stays in the main repo `.har/runs/`. Each record includes `workDir` when a slot is active.

## For coding agents

1. Read repo [`AGENT.md`](../AGENT.md)
2. Read this file and `stages.json`
3. After `launch`, read `.har/CLAUDE.agent.md` for slot URLs and definition of done

Always use `./.har/agent-cli.sh <id> ...` — never hardcoded ports.

## Architecture

Each agent slot gets isolated ports: `BASE + (AGENT_ID × 10)`.

Configure how many slots your machine can run in parallel in `stages.json` (`agentSlots`) and `harness.env` (`HARNESS_AGENT_SLOT_MIN` / `HARNESS_AGENT_SLOT_MAX`). Keep both in sync.

| Service | Agent 1 | Agent 2 |
|---------|---------|---------|
| Frontend | 3010 | 3020 |
| API | 8010 | 8020 |

Shared infra (Postgres, MinIO, etc.) runs once on fixed ports — see `harness.env` and `docker-compose.agent.yml`.

### Database

This project runs with `HARNESS_INFRA_POSTGRES=false`: all slots share the Mission Control
database from `docker-compose.yml` (`har_control` on port 5433, started with
`docker compose up -d db`). Per-slot clone-from-template (`agent_<id>` databases) only
applies when `HARNESS_INFRA_POSTGRES=true` in `harness.env`.

`launch.sh` runs `HARNESS_DB_MIGRATE_CMD` (idempotent) on every launch, so schema changes
are applied before the slot starts serving.

### Port safety

`launch.sh` refuses to start if a slot's ports are already held by a foreign process
(e.g. the app container from `docker compose up -d`, which binds slot 1's port 3847), and
fails if its own PM2 processes are not online after launch — a passing health check alone
is not trusted, since it could be answered by whatever else is bound to the port.

## Maintaining this harness

When the project stack changes (new services, different test commands, new env vars):

```bash
har env maintain
```

The authoring agent updates scripts and this README. Review changes before committing.

**Do not** put runtime behavior in YAML — edit the scripts directly.

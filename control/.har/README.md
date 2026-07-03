# .har — Agent Harness

This directory is the **agent harness** for this repository. It lets AI coding agents (Cursor, Claude Code, etc.) run the project in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/os-factory/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this app.** Need Mission Control live — manual testing, a browser session, screenshots? `launch` a slot (infra starts automatically); don't hand-roll dev-server startup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, checksums) — do not edit |
| `harness.env` | Shared config: primary app, ports, agent slot limits, `HARNESS_INFRA_SERVICES`, migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP only — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation (reads limits from `harness.env`) |
| `setup-infra.sh` | Start shared Docker infra + create template database |
| `launch.sh` | Launch one agent slot (ports, DB clone, PM2 processes) |
| `verify.sh` | Verification pipeline (typecheck, tests, health) |
| `teardown.sh` | Tear down one agent slot |
| `agent-cli.sh` | Manage a running agent (status, logs, psql, health) |
| `attach.sh` | Attach to agent tmux session |
| `env.template` | Per-agent env vars (expanded by `launch.sh`) |
| `ecosystem.agent.template.cjs` | PM2 processes for the **primary app only** (expanded by `launch.sh`) |
| `docker-compose.agent.yml` | Shared Postgres — one instance serves all slots |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

## Quick start

```bash
./.har/setup-infra.sh          # starts shared Postgres + template DB (launch runs it too)
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

| Service | Agent 1 | Agent 2 | Agent 3 |
|---------|---------|---------|---------|
| Web (UI + API) | 3847 | 3857 | 3867 |
| Database | `agent_1` | `agent_2` | `agent_3` (all on `localhost:15432`) |

### Primary app vs shared services

Each slot runs **only the primary application** (`HARNESS_PRIMARY_APP=web` — the Next.js
app serving UI + API on one port). Shared infrastructure runs **once** for all slots:
the `db` service in `docker-compose.agent.yml`, enabled via `HARNESS_INFRA_SERVICES="db"`
in `harness.env` and started by `setup-infra.sh` (launch runs it automatically).

### Database

The harness manages one shared Postgres (port 15432). `setup-infra.sh` creates
`template_control` and applies the Prisma schema to it once; `launch.sh` then clones a
per-slot database `agent_<id>` from that template, so agents never share state.

`launch.sh` also re-runs `HARNESS_DB_MIGRATE_CMD` against the slot's own database on
every launch (idempotent), so schema changes are applied before the slot starts serving.

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

## Session lifecycle

Every `launch` starts a **fresh session**: a new git worktree from the current HEAD at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
The session is recorded in `.har/slots/agent-<id>.json` (the slot registry) — status,
verify, and teardown resolve the work dir through it. Make ALL file edits under the
work dir printed by launch, never in the main checkout.

- Relaunching a slot **replaces** its previous session; if the old worktree has
  uncommitted changes, launch refuses unless `--force`.
- `teardown` removes the worktree but **keeps the session branch** so you can push it
  or open a PR (`--delete-branch` to drop it).
- `har env complete <id>` finishes a session: full verify (recorded as a validation),
  then teardown — branch kept.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

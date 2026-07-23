# .har — Agent Harness

This directory is the **agent harness** for this repository. It lets AI coding agents (Cursor, Claude Code, etc.) run the project in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Need the app live — manual testing, a browser session, screenshots? `launch` a slot; don't hand-roll docker/dev-server startup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, checksums) — do not edit |
| `harness.env` | Shared config: primary app, ports, agent slot limits, `HARNESS_INFRA_SERVICES`, toolchain provisioning, migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP only — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation (reads limits from `harness.env`) |
| `setup-infra.sh` | Start shared Docker infra + create template database |
| `launch.sh` | Launch one agent slot (ports, DB clone, toolchain provisioning, PM2 processes) |
| `provision-toolchain.sh` | Install deps and write toolchain paths to `.env.agent.<id>` |
| `verify.sh` | Verification pipeline (smoke by default; --full adds tests, lint, e2e) |
| `teardown.sh` | Tear down one agent slot |
| `agent-cli.sh` | Manage a running agent (status, logs, psql, health) |
| `attach.sh` | Attach to agent tmux session |
| `env.template` | Per-agent env vars (expanded by `launch.sh`) |
| `ecosystem.agent.template.cjs` | PM2 processes for the **primary app only** (expanded by `launch.sh`) |
| `ecosystem.shared.config.cjs` | Optional — shared app services started once by `setup-infra.sh` (only when the repo has supporting services) |
| `docker-compose.agent.yml` | Shared infrastructure containers |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

## Quick start

**Preferred — har CLI or MCP** (persists run history under `.har/runs/`):

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment`.

**Shell fallback** (no CLI/MCP installed):

```bash
./.har/setup-infra.sh          # when HARNESS_INFRA_SERVICES is non-empty
./.har/launch.sh 1
./.har/verify.sh 1             # quick: ecosystem smoke + health
./.har/verify.sh 1 --full      # + conventional tests/lint, browser-e2e (if installed)
./.har/teardown.sh 1
```

Read **`stages.json`** for registered stages and **`verificationStages`** for the expected pass set.

## Verification contract

Steps in `verify.sh` are **project-specific examples** — adapt them to your stack
during `har env init` / `har env maintain`. The table describes each tier's intent,
not a fixed command list.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` or `verify.sh <id>` | Stock ecosystem smoke + health (stops early on failure) |
| Full | `har env verify <id> --full` or `verify.sh <id> --full` | Stock conventional tests/lint, optional readiness smoke + **`browser-e2e`** when `.har/stages/browser-e2e.sh` exists |

The stock commands are deliberately generic conventions keyed by
`HARNESS_ECOSYSTEM`. Replace them with the repository's real commands during
adaptation; do not leave Node/npm, Python, Go, Rust, Java, or Ruby defaults in
place when they do not match the project.

Install Playwright stage: `har env add-stage playwright` (optional). UI changes should add or update specs under `tests/`.

## Readiness layers

Do not treat a health endpoint as the whole definition of success. Adapt this
section for the repository:

| Layer | What it means | Where to encode it |
|-------|---------------|--------------------|
| Infra ready | Shared services and template data stores exist | `setup-infra.sh`, `docker-compose.agent.yml` |
| Slot data ready | Every per-slot data store is created/cloned | `launch.sh` |
| Process ready | Primary app is running and health passes | `launch.sh`, `verify.sh` |
| Agent usable | Login/API/UI smoke works with documented data | `HARNESS_READINESS_CMD`, browser-e2e, `CLAUDE.agent.md` |

If full local-dev setup is too heavy to run in the harness, document the skipped
steps and add the minimum substitute directly in `.har/` scripts (for example an
idempotent bootstrap for required users/tenants/settings). Health alone is not
enough for UI/auth apps.

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No — same scripts, no run record |
| `har env …` / MCP | Yes — under main checkout `.har/runs/YYYY-MM-DD/` |

With git worktree slots, verification runs code in the worktree but run JSON stays in the main repo `.har/runs/`. Each record includes `workDir` when a slot is active.

## For coding agents

1. Read repo [`AGENT.md`](../AGENT.md)
2. Read this file and `stages.json`
3. After launch, read `.har/CLAUDE.agent.md` for slot URLs and definition of done

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown. Use `./.har/*.sh` only when the CLI is not installed.

Always use `./.har/agent-cli.sh <id> ...` — never hardcoded ports.

## Architecture

Each agent slot gets isolated app ports. Defaults follow `BASE + (AGENT_ID × HARNESS_PORT_STEP)`; when a default is busy, `launch.sh` scans the slot lane (`STEP` increments) and writes the resolved ports to `.env.agent.<id>` and `.har/slots/agent-<id>.json`.

Configure how many slots your machine can run in parallel in `.har/stages.json` (`agentSlots`). Bash scripts and the CLI read that first; `harness.env` keeps legacy `HARNESS_AGENT_SLOT_*` exports in sync via `har env maintain --finalize`.

| Service | Agent 1 (default) | Agent 2 (default) |
|---------|-------------------|-------------------|
| Frontend | 3010 | 3020 |
| API | 8010 | 8020 |
| Node debug | 9210 | 9220 |

## Port & shared services

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| App — frontend | Per slot | `HARNESS_FE_BASE_PORT + (AGENT_ID × HARNESS_PORT_STEP)` | Scan `STEP` increments within the slot lane |
| App — API | Per slot | `HARNESS_API_BASE_PORT + (AGENT_ID × STEP)` | Same scan policy |
| Node debug | Per slot | `9200 + (AGENT_ID × STEP)` | Same scan policy |
| Shared Postgres | Per machine | `HARNESS_DB_PORT_DEFAULT` | Scan `HARNESS_DB_PORT_SCAN_START..END` |
| MinIO / S3 | Per machine | `HARNESS_MINIO_PORT_DEFAULT` (+ console port) | Scan configured ranges in `harness.env` |
| Mailpit | Per machine | `HARNESS_MAILPIT_*_PORT_DEFAULT` | Scan configured ranges |
| Headless browser | Per machine | `HARNESS_BROWSER_PORT_DEFAULT` | Scan configured ranges |

Resolved ports may differ from the formula when something else is already bound. Always use `./.har/agent-cli.sh <id>` or read `.har/slots/agent-<id>.json` — never hardcode `3010`, `15432`, etc. in app code or tests.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| Postgres | One shared container; per-slot database `agent_<id>` cloned from template | `HARNESS_INFRA_SERVICES="db"` |
| MinIO / S3 | One shared container; per-slot bucket `agent-<id>` | `HARNESS_INFRA_SERVICES="... minio"` |
| Mailpit, Redis, etc. | One shared container on a scanned host port | Listed in `HARNESS_INFRA_SERVICES` |
| Primary application | One PM2 ecosystem per slot (isolated ports) | `HARNESS_PRIMARY_APP`, `ecosystem.agent.template.cjs` |
| Internal supporting services | Shared across all slots | `docker-compose.agent.yml` or `ecosystem.shared.config.cjs` |

Shared infra starts once via `./.har/setup-infra.sh` (also run automatically by `launch.sh`). Per-slot databases are cloned in `launch.sh`.

### Do not

- Hardcode default ports (`3000`, `15432`, `3847`, …) in application code, tests, or agent docs — read from `.env.agent.<id>`, `agent-cli.sh`, or the slot registry
- Run raw `docker compose` for harness infrastructure — use `setup-infra.sh` / `launch.sh` so ports are scanned and persisted in `.har/state/infra.env`

### Primary app vs shared services

Each slot runs **only the primary application** (`HARNESS_PRIMARY_APP` in `harness.env`) — the app agents modify. Everything else runs **once**, shared by all slots on fixed ports:

- **External dependencies** (Postgres, Redis, mail, ...): services in `docker-compose.agent.yml`, enabled via the `HARNESS_INFRA_SERVICES` list in `harness.env`, started by `setup-infra.sh`.
- **Internal supporting services** (other services of a monolith/monorepo the agent depends on but does not change): either compose services in `docker-compose.agent.yml`, or PM2 processes in an optional `.har/ecosystem.shared.config.cjs` (named `har-shared-<name>`, started by `setup-infra.sh`).

Isolation still applies where it matters: each slot gets its own database (`agent_<id>`, cloned from the template DB), ports, and git worktree.

## Maintaining this harness

When the project stack changes (new services, different test commands, new env vars):

```bash
har env maintain
```

The authoring agent updates scripts and this README. Review changes before committing.

**Do not** put runtime behavior in YAML — edit the scripts directly.

## Session lifecycle

Every `launch` starts a **new session**: a git worktree from the current HEAD of the
**main checkout** (`$REPO_ROOT`) at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
Set `--purpose=label` / `HAR_SESSION_PURPOSE` on every launch as the human-facing task label.
The session is recorded in `.har/slots/agent-<id>.json` (the slot registry) — status,
verify, and teardown resolve the work dir through it. Make ALL file edits under the
work dir printed by launch, never in the main checkout.

- To free/clean a slot: prefer `complete` / `teardown`, then `launch`. `--replace` only
  reuses the same slot id immediately — it does **not** select `main` or inherit the
  previous task. For a new unrelated task, switch the main checkout to `main` first.
- Occupied-slot warnings show what will be destroyed **and** the new session base
  (`$REPO_ROOT` branch @ sha).
- Replacement requires `--replace` / `confirmReplace=true` (or an interactive prompt).
  Dirty worktrees also need `--force` after explicit user approval.
- `teardown` removes the worktree but **keeps the session branch** so you can push it
  or open a PR (`--delete-branch` to drop it).
- If launch fails after creating a worktree/env file, the registry records `status: failed`.
  Resume without `--replace`: `har env launch <id> --resume` or `har env recover <id>`.
- `har env complete <id>` finishes a session: full verify (recorded as a validation),
  then teardown — branch kept.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

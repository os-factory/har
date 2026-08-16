# .har — Agent Harness (Mission Control)

This directory is the **agent harness** for Mission Control. It lets AI coding agents run the app in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

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
| `setup-infra.sh` | Start optional shared Docker infra (unused — Mission Control uses embedded SQLite) |
| `launch.sh` | Launch one agent slot (worktree, toolchain, PM2 processes) |
| `provision-toolchain.sh` | Install deps (`control/`, monorepo root, `@har/schemas`) and write `NODE_BIN` / `NPM_BIN` to `.env.agent.<id>` |
| `verify.sh` | Verification pipeline (typecheck, tests, health) |
| `teardown.sh` | Tear down one agent slot |
| `agent-cli.sh` | Manage a running agent (status, logs, sqlite, health) |
| `attach.sh` | Attach to agent tmux session |
| `env.template` | Per-agent env vars (expanded by `launch.sh`) |
| `ecosystem.agent.template.cjs` | PM2 processes for the **primary app only** (expanded by `launch.sh`) |
| `ecosystem.shared.config.cjs` | Optional — shared app services started once by `setup-infra.sh` (not used by Control today) |
| `docker-compose.agent.yml` | Empty stub — no shared Docker services (SQLite per slot) |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

## Quick start

**Preferred — har CLI or MCP** (persists run history under `.har/runs/`):

```bash
cd control
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment` (run from `control/` or point MCP at this harness).

**Shell fallback** (no CLI/MCP installed):

```bash
cd control
./.har/setup-infra.sh          # no-op when HARNESS_INFRA_SERVICES is empty (default)
./.har/launch.sh 1
./.har/verify.sh 1             # quick: typecheck, tests, health
./.har/verify.sh 1 --full      # done gate: + lint + browser-e2e (if Playwright stage installed)
./.har/teardown.sh 1
```

Read **`stages.json`** for registered stages and **`verificationStages`** for the expected pass set.

## Verification contract

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` or `verify.sh <id>` | typecheck, unit tests, api-health |
| Full | `har env verify <id> --full` or `verify.sh <id> --full` | + lint + optional readiness smoke + **`browser-e2e`** + **`docker-build`** (when those stage scripts exist) |

Install Playwright plugin: `har env add-plugin playwright` (optional). UI changes should add or update specs under `tests/`.
The `docker-build` stage builds `control/Dockerfile` against the session worktree (no push; native platform), then smoke-boots the image and waits for `/api/health`. That catches first-boot failures (for example a broken Prisma CLI / missing wasm) that a build-only check would miss. PR CI runs this via `control` job `./.har/verify.sh 1 --full`.

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No — same scripts, no run record |
| `har env …` / MCP | Yes — under main checkout `control/.har/runs/YYYY-MM-DD/` |

With git worktree slots, verification runs code in the worktree but run JSON stays in the main repo `.har/runs/`. Each record includes `workDir` when a slot is active.

## For coding agents

1. Read repo [`AGENTS.md`](../AGENTS.md)
2. Read this file and `stages.json`
3. After `launch`, read `.har/CLAUDE.agent.md` for slot URLs and definition of done

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown. Use `./.har/*.sh` only when the CLI is not installed.

Always use `./.har/agent-cli.sh <id> ...` — never hardcoded ports.

## Architecture

Each agent slot gets isolated app ports. Defaults follow `BASE + (AGENT_ID × HARNESS_PORT_STEP)`; when a default is busy, `launch.sh` scans the slot lane and writes resolved ports to `.env.agent.<id>` and `.har/slots/agent-<id>.json`.

Configure how many slots your machine can run in parallel in `.har/stages.json` (`agentSlots`). Bash scripts and the CLI read that first; `harness.env` keeps legacy `HARNESS_AGENT_SLOT_*` exports in sync via `har env maintain --finalize`.

| Service | Agent 1 (default) | Agent 2 (default) | Agent 3 (default) |
|---------|-------------------|-------------------|-------------------|
| Web (UI + API) | 3847 | 3857 | 3867 |
| Database | `prisma/agent_1.db` | `prisma/agent_2.db` | `prisma/agent_3.db` (SQLite per slot) |

`HARNESS_FE_BASE_PORT=3837` and `HARNESS_API_BASE_PORT=3837` — slot 1 therefore defaults to **3847** (`3837 + 1 × 10`).

## Port & shared services

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Web (UI + API) | Per slot | `HARNESS_FE_BASE_PORT + (AGENT_ID × HARNESS_PORT_STEP)` | Scan `STEP` increments within the slot lane |

Always use `./.har/agent-cli.sh <id>` or read `.har/slots/agent-<id>.json` — never hardcode `3847` in app code or tests.

### `har control up` vs harness slot 1

These are **different ways to run Mission Control** and they **conflict on port 3847**:

| Entry point | What it runs | Default port |
|-------------|--------------|--------------|
| `har control up` | Docker image `theosfactory/har-control` | **3847** (UI/API) |
| `cd control && har env launch 1` | Harness slot with PM2 + per-slot SQLite | **3847** for slot 1 |

Do not run both at once. Before launching harness slot 1, run `har control down` if the control container is up. `launch.sh` preflight also detects a Mission Control container bound to the slot port and fails with a clear message.

For day-to-day agent work on Mission Control itself, use the **harness** (`cd control && har env launch 1`). Use `har control up` when you want the published Docker image without a worktree slot.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| SQLite | One file per slot (`prisma/agent_<id>.db`) | `har_slot_db_url` / `HARNESS_DB_MIGRATE_CMD` |
| Next.js app | One PM2 process per slot on isolated ports | `HARNESS_PRIMARY_APP=web`, `ecosystem.agent.template.cjs` |

### Do not

- Hardcode `3847` in app code, Playwright specs, or docs — read from agent env / slot registry
- Run raw `docker compose` for harness infrastructure — use `setup-infra.sh` / `launch.sh`

### Primary app vs shared services

Each slot runs **only the primary application** (`HARNESS_PRIMARY_APP=web` — the Next.js
app serving UI + API on one port). `HARNESS_INFRA_SERVICES` is empty — no shared Docker
database. `docker-compose.agent.yml` is a stub for a future service if one is needed.

### Database

Each slot gets its own SQLite file at `prisma/agent_<id>.db`. `launch.sh` runs
`HARNESS_DB_MIGRATE_CMD` (`prisma db push`) against that file on every launch
(idempotent), so schema changes are applied before the slot starts serving.

It also installs `@har/schemas` dependencies under `packages/schemas/` when typechecking
from a fresh worktree (monorepo `file:` link).

### Port safety

`launch.sh` and `har env preflight` refuse to start when a slot's allocated ports are held by a
foreign process. **`har control up`** (Docker `control-app-1` on port 3847) is detected explicitly:

- If the default port is busy but another port in the slot lane is free, launch proceeds on the
  alternate port and warns that `har control up` holds the default.
- If no port in the lane is free, preflight blocks with `control_port_conflict` and suggests
  `har control down` or a different slot id.

`har control up` warns when `control/.har` slot 1 is already active. Recommended workflow: harness
for agent dev, `har control up` for the packaged dashboard — not both on 3847 without an explicit choice.

## Maintaining this harness

When the project stack changes (new services, different test commands, new env vars):

```bash
cd control && har env maintain
```

The authoring agent updates scripts and this README. Review changes before committing.

**Do not** put runtime behavior in YAML — edit the scripts directly.

## Session lifecycle

Every `launch` starts a **fresh session**: a new git worktree from the **main
checkout's current HEAD** at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
Switch that checkout to your intended base before launch. The session is recorded in
`.har/slots/agent-<id>.json` (the slot registry) — status, verify, and teardown resolve
the work dir through it. Make ALL file edits under the work dir printed by launch,
never in the main checkout.

- Occupied slots always block a new launch: `har env complete <id>` (or `teardown <id>`),
  then `har env launch <id>`. A new launch never chooses `main` for you — switch the
  main checkout to your intended base first.
- `teardown` removes the worktree but **keeps the session branch** so you can push it
  or open a PR (`--delete-branch` to drop it).
- `har env complete <id>` finishes a session: full verify (recorded as a validation),
  then teardown — branch kept.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

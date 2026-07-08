# .har — Agent Harness

This directory is the **agent harness** for this repository. It lets AI coding agents (Cursor, Claude Code, etc.) run the project in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Need the app live — manual testing, a browser session, screenshots? `launch` a slot; don't hand-roll docker/dev-server startup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

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
./.har/verify.sh 1             # quick: smoke (typecheck + health)
./.har/verify.sh 1 --full      # + unit tests, lint, browser-e2e (if Playwright stage installed)
./.har/teardown.sh 1
```

Read **`stages.json`** for registered stages and **`verificationStages`** for the expected pass set.

## Verification contract

Steps in `verify.sh` are **project-specific examples** — adapt them to your stack
during `har env init` / `har env maintain`. The table describes each tier's intent,
not a fixed command list.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` or `verify.sh <id>` | Smoke: compile / typecheck / health (stops early on failure) |
| Full | `har env verify <id> --full` or `verify.sh <id> --full` | + unit tests, lint, optional readiness smoke + **`browser-e2e`** when `.har/stages/browser-e2e.sh` exists |

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

Each agent slot gets isolated ports: `BASE + (AGENT_ID × 10)`.

Configure how many slots your machine can run in parallel in `stages.json` (`agentSlots`) and `harness.env` (`HARNESS_AGENT_SLOT_MIN` / `HARNESS_AGENT_SLOT_MAX`). Keep both in sync.

| Service | Agent 1 | Agent 2 |
|---------|---------|---------|
| Frontend | 3010 | 3020 |
| API | 8010 | 8020 |

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

Every `launch` starts a **fresh session**: a new git worktree from the current HEAD at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
The session is recorded in `.har/slots/agent-<id>.json` (the slot registry) — status,
verify, and teardown resolve the work dir through it. Make ALL file edits under the
work dir printed by launch, never in the main checkout.

- Relaunching a slot **replaces** its previous session; replacement requires `--replace` /
  `confirmReplace=true` (or an interactive prompt). Uncommitted changes also need `--force`
  after explicit user approval.
- `teardown` removes the worktree but **keeps the session branch** so you can push it
  or open a PR (`--delete-branch` to drop it).
- `har env complete <id>` finishes a session: full verify (recorded as a validation),
  then teardown — branch kept.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

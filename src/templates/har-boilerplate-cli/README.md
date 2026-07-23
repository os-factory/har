# .har — Agent Harness (CLI / library profile)

This directory is the **agent harness** for this repository. It lets AI coding agents run the project in isolated git worktrees with optional Docker-backed shared infra.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Launch a slot to exercise the code in isolation; don't hand-roll setup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, profile, checksums) — do not edit |
| `harness.env` | Shared config: worktree default, `HARNESS_INFRA_SERVICES`, toolchain provisioning (`HARNESS_ECOSYSTEM`, `HARNESS_INSTALL_CMD`), migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP only — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation (reads limits from `harness.env`) |
| `setup-infra.sh` | Start optional Docker Compose stack + template database |
| `launch.sh` | Launch one agent slot (git worktree by default, toolchain provisioning, env file) |
| `provision-toolchain.sh` | Install deps and write toolchain paths (`PYTHON_BIN`, `NPM_BIN`, …) to `.env.agent.<id>` |
| `verify.sh` | Verification pipeline (smoke by default; --full adds tests, lint, e2e) |
| `teardown.sh` | Tear down one agent slot (worktree + env file) |
| `agent-cli.sh` | Inspect slot status, run commands in the work dir |
| `docker-compose.agent.yml` | Shared infrastructure containers (services listed in `HARNESS_INFRA_SERVICES`) |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

No PM2 or `ecosystem.agent.template.cjs` in this profile — agents run project commands directly in their worktree.

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
./.har/verify.sh 1             # quick: ecosystem smoke (compile/import/build)
./.har/verify.sh 1 --full      # + conventional tests, lint, browser-e2e (if installed)
./.har/teardown.sh 1
```

Read **`stages.json`** and **`verificationStages`**. Optional: `har env add-stage playwright`.

## Verification contract

Steps in `verify.sh` are **project-specific examples** — adapt them to your stack
during `har env init` / `har env maintain` / benchmark setup. The table describes
each tier's intent, not a fixed command list.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` or `verify.sh <id>` | Stock ecosystem smoke: compile / import / build conventions |
| Full | `har env verify <id> --full` or `verify.sh <id> --full` | Stock conventional tests/lint + optional readiness smoke, **browser-e2e** when `stages/browser-e2e.sh` exists |

The stock commands are deliberately generic conventions keyed by
`HARNESS_ECOSYSTEM`. Replace them with the repository's real commands during
adaptation; do not leave Node/npm, Python, Go, Rust, Java, or Ruby defaults in
place when they do not match the project.

For repos that need runtime services, distinguish health from usability. If the
harness skips slow local-dev setup, document the skipped steps and add a minimal
bootstrap/readiness check when agents need default data, credentials, or an
authenticated workflow.

Use `har env launch 1 --no-worktree` or `./.har/launch.sh 1 --no-worktree` only when working in the repo root.

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No |
| `har env …` / MCP | Yes — main checkout `.har/runs/YYYY-MM-DD/` |

With worktree slots, tests run in the worktree; run JSON lives in the main repo. See `workDir` in each record.

## For coding agents

**Start here:** read [`AGENT.md`](../AGENT.md) at the repo root for a short pointer, then [`.har/CLAUDE.agent.md`](./CLAUDE.agent.md) for full instructions.

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown. Use `./.har/*.sh` only when the CLI is not installed.

Work in the isolated git worktree created by launch. Use `./.har/agent-cli.sh <id> exec ...` to run ad-hoc project commands in that work dir.

When the project needs Postgres, Redis, or similar, add the service to `docker-compose.agent.yml` (or keep one from the menu), list it in `HARNESS_INFRA_SERVICES` in `harness.env`, and use `setup-infra.sh` — never run raw `docker compose` for shared infra. Shared services run once on fixed ports and serve every agent slot.

## Port & shared services (CLI profile)

This profile has **no PM2 app ports** — agents run project commands directly in their worktree. Port variables in `harness.env` exist for optional test servers and for shared Docker infra.

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Shared Postgres | Per machine | `HARNESS_DB_PORT_DEFAULT` | Scan `HARNESS_DB_PORT_SCAN_START..END` |
| Other compose services | Per machine | `HARNESS_*_PORT_DEFAULT` for that service | Scan configured ranges in `harness.env` |

When a repo adds a local HTTP server for integration tests, prefer reading ports from `.env.agent.<id>` or `./.har/agent-cli.sh <id>` rather than hardcoding values.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| Postgres / Redis / mail / … | One shared container on a scanned host port | `HARNESS_INFRA_SERVICES` + matching vars in `harness.env` |
| Per-slot databases | Cloned from template DB when `db` is enabled | `launch.sh` |
| Application code | Isolated git worktree per slot | `HARNESS_USE_WORKTREE=true` |

### Do not

- Hardcode `15432` or other default infra ports in tests — read `AGENT_DB_PORT` from `.env.agent.<id>` or `har_pg`
- Run raw `docker compose` for harness infrastructure — use `setup-infra.sh`

## Maintaining this harness

When the project stack changes (new test commands, database needs, env vars):

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
- If launch fails after creating a worktree/env file, resume with
  `har env launch <id> --resume` or `har env recover <id>`.
- `har env complete <id>` finishes a session: full verify (recorded as a validation),
  then teardown — branch kept.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

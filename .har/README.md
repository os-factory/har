# .har — Agent Harness (@osfactory/har)

This directory is the **agent harness** for this repository. It lets AI coding agents run `@osfactory/har` in isolated git worktrees with optional Docker-backed shared infra.

Generated and maintained by [`har`](https://github.com/os-factory/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Launch a slot to exercise the code in isolation; don't hand-roll setup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

**Yours — the configuration surface** (edit freely; drift tracking records adaptations):

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `harness.env` | Schema-validated config: worktree default, `HARNESS_INFRA_SERVICES`, toolchain provisioning (`HARNESS_ECOSYSTEM`, `HARNESS_INSTALL_CMD`), migrate/seed commands |
| `stages.json` | Registered stages, verification tiers, artifacts, slot limits, gate policy |
| `stages/` | Project-owned stage scripts registered from `stages.json` |
| `stages/fixture-e2e.sh` | v1.0.0 milestone gate — built CLI vs a car-app fixture clone (opt-in via `HAR_FIXTURE_E2E=1`; see `.claude/skills/v1-milestone/`) |
| `hooks/` | Optional lifecycle hooks (`pre-launch.sh`, `post-launch.sh`, `pre-verify.sh`, `pre-teardown.sh`, `post-teardown.sh`) |
| `plugins/` | Optional local plugins (`har plugin create <id>`) |
| `docker-compose.agent.yml` | Shared infrastructure containers (services listed in `HARNESS_INFRA_SERVICES`) |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated shims and state** (don't edit — `har env eject` for full ownership):

| File | Purpose |
|------|---------|
| `launch.sh` / `verify.sh` / `teardown.sh` / `setup-infra.sh` / `preflight.sh` / `agent-cli.sh` | Thin shims forwarding to the packaged runtime (`har env …`); same run records on every surface |
| `manifest.json` | Runtime version, profile, checksums — managed by the har CLI |
| `runs/` | Run history from **every** entry point — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignored) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |

Since 1.0 the runtime lives in the `@osfactory/har` package, not here — there is no
`agent-slot.sh`, `provision-toolchain.sh`, `simulator.sh`, or `lib/`. Toolchain
provisioning is config (`HARNESS_ECOSYSTEM`, `HARNESS_INSTALL_CMD`) plus
`hooks/post-launch.sh`.

No PM2, `attach.sh`, or `ecosystem.agent.template.cjs` in this profile — agents run project commands directly in their worktree.

## Quick start

**har CLI or MCP** (structured output, tracker binding):

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment`.

**Shell shims** (identical behavior and run records; handy with no CLI installed):

```bash
./.har/setup-infra.sh          # when HARNESS_INFRA_SERVICES is non-empty
./.har/launch.sh 1
./.har/verify.sh 1             # quick: typecheck + build + docs check/build
./.har/verify.sh 1 --full      # + unit tests, lint, docs-drift
./.har/teardown.sh 1
```

Read **`stages.json`** and **`verificationStages`**. Browser E2E (Playwright) lives in [`control/.har/`](../control/.har/) — not this CLI harness.

## Verification contract

Steps in `verify.sh` are adapted for **@osfactory/har** — typecheck, build, docs site checks, and (full mode) unit tests, lint, and registered stages.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` or `verify.sh <id>` | Typecheck, build, docs check/build |
| Full | `har env verify <id> --full` or `verify.sh <id> --full` | + unit tests, lint, readiness, `docs-drift` |

This CLI harness has no runtime server — full verify is static analysis and tests only. A slot is **agent usable** when typecheck, build, docs check/build, unit tests, lint, and `docs-drift` pass. Mission Control dogfooding uses `control/.har/`; the docs site uses `docs/.har/`.

Use `har env launch 1 --no-worktree` or `./.har/launch.sh 1 --no-worktree` only when working in the repo root.

## Run history

Every entry point — `./.har/*.sh`, `har env …`, MCP — runs the same packaged
runtime and writes the same records under the main checkout
`.har/runs/YYYY-MM-DD/`. The shims delegate; they do not record less.

With worktree slots, tests run in the worktree; run JSON lives in the main repo. See `workDir` in each record.

## For coding agents

**Start here:** read [`AGENTS.md`](../AGENTS.md) at the repo root for a short pointer, then [`.har/CLAUDE.agent.md`](./CLAUDE.agent.md) for full instructions.

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown. Use `./.har/*.sh` only when the CLI is not installed.

Work in the isolated git worktree created by launch. Use `./.har/agent-cli.sh <id> exec ...` to run ad-hoc project commands in that work dir.

When the project needs Postgres, Redis, or similar, add the service to `docker-compose.agent.yml`, list it in `HARNESS_INFRA_SERVICES` in `harness.env`, and use `setup-infra.sh` — never run raw `docker compose` for shared infra.

## Port & shared services (CLI profile)

This profile has **no PM2 app ports** — agents run project commands directly in their worktree. Port variables in `harness.env` exist for optional test servers and for shared Docker infra.

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Shared Postgres | Per machine | `HARNESS_DB_PORT_DEFAULT` | Scan `HARNESS_DB_PORT_SCAN_START..END` |
| Other compose services | Per machine | `HARNESS_*_PORT_DEFAULT` for that service | Scan configured ranges in `harness.env` |
| Per-slot HTTP (optional) | Per slot | `HARNESS_*_BASE_PORT + agentId * HARNESS_PORT_STEP` | — |

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
- If launch fails after creating a worktree/env file, resume with
  `har env launch <id> --resume` or `har env recover <id>`.
- `har env complete <id>` finishes a session: full verify (recorded as a validation),
  then teardown — branch kept.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

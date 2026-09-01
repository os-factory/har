# .har — Agent Harness (Mission Control)

This directory is the **agent harness** for Mission Control. It lets AI coding agents run the app in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this app.** Need Mission Control live — manual testing, a browser session, screenshots? `launch` a slot (infra starts automatically); don't hand-roll dev-server startup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

## What's in here

**Yours — the configuration surface** (edit freely; drift tracking records adaptations):

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `harness.env` | Schema-validated config: primary app, ports, agent slot limits, `HARNESS_INFRA_SERVICES`, migrate/seed commands |
| `stages.json` | Registered stages, verification tiers, artifacts, slot limits, gate policy |
| `stages/` | Project-owned stage scripts (`api-health.sh`, `browser-e2e.sh`, `docker-build.sh`, `readiness.sh`) |
| `hooks/` | Lifecycle hooks — `pre-teardown.sh` drops the slot's SQLite store |
| `plugins/` | Optional local plugins (`har plugin create <id>`) |
| `env.template` | Per-agent env vars (expanded into `.env.agent.<id>` at launch) |
| `ecosystem.agent.template.cjs` | PM2 processes for the **primary app only** (expanded at launch) |
| `docker-compose.agent.yml` | Empty stub — no shared Docker services (SQLite per slot) |
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated state** (don't edit — `har env eject` vendors `.har/runtime/`):

| File | Purpose |
|------|---------|
| `manifest.json` | Runtime version, profile, checksums — managed by the har CLI |
| `runs/` | Run history from **every** entry point — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignored) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |

Since 1.0 the runtime lives in the `@osfactory/har` package, not here — there is no
`agent-slot.sh`, `provision-toolchain.sh`, or `lib/`. Toolchain provisioning is
config (`HARNESS_ECOSYSTEM`, `HARNESS_INSTALL_CMD`); per-slot cleanup is a hook.

## Quick start

**har CLI or MCP** (structured output, tracker binding):

```bash
cd control
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment` (run from `control/` or point MCP at this harness).

CLI and MCP are the only entry points. `har env eject` vendors the runtime into
`.har/runtime/` for offline ownership (`node .har/runtime/har.cjs env …`).

Read **`stages.json`** for registered stages and **`verificationStages`** for the expected pass set.

## Verification contract

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` | typecheck, unit tests, api-health |
| Full | `har env verify <id> --full` | + lint + optional readiness smoke + **`browser-e2e`** + **`docker-build`** (when those stage scripts exist) |

Install Playwright plugin: `har env add-plugin playwright` (optional). UI changes should add or update specs under `tests/`.
The `docker-build` stage builds `control/Dockerfile` against the session worktree (no push; native platform), then smoke-boots the image and waits for `/api/health`. That catches first-boot failures (for example a broken Prisma CLI / missing wasm) that a build-only check would miss. PR CI runs this via the `control` job's full verify.

## Run history

Every entry point — `har env …`, MCP — runs the same packaged
runtime and writes the same records under the main checkout
`control/.har/runs/YYYY-MM-DD/`. The shims delegate; they do not record less.

With git worktree slots, verification runs code in the worktree but run JSON stays in the main repo `.har/runs/`. Each record includes `workDir` when a slot is active.

## For coding agents

1. Read repo [`AGENTS.md`](../AGENTS.md)
2. Read this file and `stages.json`
3. After `launch`, this file has the slot URLs and definition of done

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown.

Always use `har env agent <id>` — never hardcoded ports.

## Architecture

Each agent slot gets isolated app ports. Defaults follow `BASE + (AGENT_ID × HARNESS_PORT_STEP)`; when a default is busy, `har env launch` scans the slot lane and writes resolved ports to `.env.agent.<id>` and `.har/slots/agent-<id>.json`.

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

Always use `har env agent <id>` or read `.har/slots/agent-<id>.json` — never hardcode `3847` in app code or tests.

### `har control up` vs harness slot 1

These are **different ways to run Mission Control** and they **conflict on port 3847**:

| Entry point | What it runs | Default port |
|-------------|--------------|--------------|
| `har control up` | Docker image `theosfactory/har-control` | **3847** (UI/API) |
| `cd control && har env launch 1` | Harness slot with PM2 + per-slot SQLite | **3847** for slot 1 |

Do not run both at once. Before launching harness slot 1, run `har control down` if the control container is up. `har env launch` preflight also detects a Mission Control container bound to the slot port and fails with a clear message.

For day-to-day agent work on Mission Control itself, use the **harness** (`cd control && har env launch 1`). Use `har control up` when you want the published Docker image without a worktree slot.

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| SQLite | One file per slot (`prisma/agent_<id>.db`) | `har_slot_db_url` / `HARNESS_DB_MIGRATE_CMD` |
| Next.js app | One PM2 process per slot on isolated ports | `HARNESS_PRIMARY_APP=web`, `ecosystem.agent.template.cjs` |

### Do not

- Hardcode `3847` in app code, Playwright specs, or docs — read from agent env / slot registry
- Run raw `docker compose` for harness infrastructure — use `har env setup-infra` / `har env launch`

### Primary app vs shared services

Each slot runs **only the primary application** (`HARNESS_PRIMARY_APP=web` — the Next.js
app serving UI + API on one port). `HARNESS_INFRA_SERVICES` is empty — no shared Docker
database. `docker-compose.agent.yml` is a stub for a future service if one is needed.

### Database

Each slot gets its own SQLite file at `prisma/agent_<id>.db`. `har env launch` runs
`HARNESS_DB_MIGRATE_CMD` (`prisma db push`) against that file on every launch
(idempotent), so schema changes are applied before the slot starts serving.

It also installs `@har/schemas` dependencies under `packages/schemas/` when typechecking
from a fresh worktree (monorepo `file:` link).

### Port safety

`har env launch` and `har env preflight` refuse to start when a slot's allocated ports are held by a
foreign process. **`har control up`** (Docker `control-app-1` on port 3847) is detected explicitly:

- If the default port is busy but another port in the slot lane is free, launch proceeds on the
  alternate port and warns that `har control up` holds the default.
- If no port in the lane is free, preflight blocks with `control_port_conflict` and suggests
  `har control down` or a different slot id.

`har control up` warns when `control/.har` slot 1 is already active. Recommended workflow: harness
for agent dev, `har control up` for the packaged dashboard — not both on 3847 without an explicit choice.

## Environment

| | |
|--|--|
| **App URL** | the slot URL (`har env agent <id> url`) |
| **Health** | the slot URL (`har env agent <id> url`)/api/health |
| **Database** | SQLite `prisma/agent_<id>.db` in the session work dir (created by `prisma db push` at launch) |
| **Work dir** | Fresh session worktree per launch — see the launch output or `control/.har/slots/agent-<id>.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Edits there hot-reload in the running slot (`next dev`); use `har env agent <id> restart web` if a change doesn't take. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

This slot runs **only the primary application** (`HARNESS_PRIMARY_APP=web`, the Next.js app). Mission Control uses **embedded SQLite** per slot — no shared Postgres (`HARNESS_INFRA_SERVICES` is empty).

```bash
har env agent <id> status
har env agent <id> logs web
har env agent <id> health
```

## Readiness — what “agent usable” means

1. **Process ready** — `har env agent <id> health` (`/api/health`)
2. **Slot data ready** — SQLite `prisma/agent_<id>.db` exists (created by `prisma db push` at launch)
3. **Workflow usable** — dashboard loads at the slot URL (`har env agent <id> url`); no shared Postgres
4. **No extra credentials** — local SQLite, no seed login required

## Definition of done

A task is complete only when:

- [ ] Full verification returns `"status": "pass"` (`har env verify <id> --full`, MCP `har_run_verification` with `full: true`, or `har env verify <id> --full`)
- [ ] The app is agent-usable for the documented smoke workflow, not only health-check green
- [ ] When `stages/browser-e2e.sh` exists, full verify includes Playwright — adapt specs under `tests/` for UI changes
- [ ] New or changed UI behavior has coverage in `tests/` (unit and/or Playwright as appropriate)
- [ ] Changes are committed **in the session worktree** with a clear message
- [ ] The user got the app URL (the slot URL (`har env agent <id> url`)) to test themselves
- [ ] Present session handoff (summary, branch, preview URLs) and **wait for user** before `complete`, push, or PR
- [ ] On user approval of the default: push + open PR (when `gh`/GitHub MCP available), then `har env complete <id>` (or MCP `har_complete_environment`) — reuse last passing full validation + teardown, branch kept. Pass `--verify` / `verify: true` if the tree may have changed.

### Session handoff

After full verify and commit, stop and propose next steps. Never autonomously run
`complete`, `teardown`, `git push`, or open a PR. **Default recommendation:** when
`gh` or GitHub MCP is available, complete the slot **and** open a PR (push → PR →
`har env complete` / `har_complete_environment`). Offer complete-only or something
else as alternatives. If PR tooling is unavailable, recommend complete and report
the session branch for a manual push. Prefer `complete` over bare `teardown` when
the work succeeded. See `.cursor/rules/har-workflow.mdc` for the handoff shape.

Quick check during development: `har env verify <id>` (stops before lint/e2e).

## Project commands (in work dir)

```bash
npm run typecheck
npm test
npm run lint
npm run test:e2e          # Playwright only
```

## Do not

- Hand-roll docker/dev-server startup — `launch` is how you run the app (manual testing, browser, screenshots included)
- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Hardcode ports — use agent env / `agent-cli.sh url`
- Run raw `docker compose` for shared harness infra — use `har env setup-infra`
- Edit `.env.agent.<id>` or PM2 ecosystem files by hand
- Skip `launch` before `verify` (server must be running for health and e2e)
- Edit the main checkout — all edits go under the session work dir

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
- `har env complete <id>` finishes a session: reuses the last matching passing
  full validation, then teardown — branch kept. Pass `--verify` to re-run full
  verify if the tree may have changed.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

# .har — Agent Harness (docs site)

This directory is the **agent harness** for the Astro docs / marketing site under
`docs/`. Coding agents get an isolated slot (worktree, port, PM2 `astro dev`)
plus Playwright verification with **before/after screenshots**.

Generated and maintained by [`har`](https://github.com/os-factory/har). Run
`cd docs && har env maintain` when the stack changes.

**The harness is how you run this site.** Need the landing page or docs live —
manual testing, browser, screenshots? `launch` a slot; don't hand-roll
`astro dev`. If a harness command fails, fix the harness or report it.

This is one of **three** harnesses in the monorepo — see the root
[`AGENTS.md`](../../AGENTS.md) table. Use this one when changing `docs/`.

## What's in here

**Yours — the configuration surface** (edit freely; drift tracking records adaptations):

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `harness.env` | Primary app, ports, empty infra list, readiness smoke |
| `stages.json` | Stage registry + `verificationStages` + agent slot limits |
| `stages/` | `browser-e2e.sh`, `capture-screenshots.sh`, `api-health.sh`, `readiness.sh`, Playwright docs |
| `hooks/` | Lifecycle hooks — `post-launch.sh` installs docs deps |
| `plugins/` | Optional local plugins (`har plugin create <id>`) |
| `env.template` | Per-agent env (expanded into `.env.agent.<id>` at launch) |
| `ecosystem.agent.template.cjs` | PM2: `astro dev` for the primary app only |
| `docker-compose.agent.yml` | Empty — no shared Docker services |
| `CLAUDE.agent.md` | Slot URLs, screenshot handoff, definition of done |
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated shims and state** (don't edit — `har env eject` for full ownership):

| File | Purpose |
|------|---------|
| `launch.sh` / `verify.sh` / `teardown.sh` / `setup-infra.sh` / `preflight.sh` / `agent-cli.sh` / `attach.sh` | Thin shims forwarding to the packaged runtime (`har env …`); same run records on every surface |
| `manifest.json` | Runtime version, profile, checksums — managed by the har CLI |
| `runs/` | Run history from **every** entry point (gitignored) |
| `artifacts/` | Reports, traces, **before/after screenshots** (gitignored) |

Since 1.0 the runtime lives in the `@osfactory/har` package, not here — there is no
`agent-slot.sh`, `provision-toolchain.sh`, or `lib/`. Worktree setup, toolchain
provisioning, PM2 and baseline screenshots are the packaged launch runtime plus
`hooks/post-launch.sh`.

## Quick start

**Preferred — har CLI or MCP** (persists run history under `.har/runs/`):

```bash
cd docs
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

**Shell fallback:**

```bash
cd docs
./.har/launch.sh 1
./.har/verify.sh 1             # quick: astro check + site health
./.har/verify.sh 1 --full      # + drift, build, links, browser-e2e + after screenshots
./.har/teardown.sh 1
```

## Verification contract

| Mode | Command | Steps |
|------|---------|-------|
| Quick | `har env verify <id>` | `npm run check`, site HTTP health on `/` |
| Full | `har env verify <id> --full` | + `drift`, `build`, `links` (when `lychee` is on PATH; CI installs it), readiness smoke, **`browser-e2e`** (Playwright + after screenshots) |

### Screenshot proof

| Phase | When | Location |
|-------|------|----------|
| **before** | End of `launch` (baseline) | `.har/artifacts/browser-e2e/screenshots/before/` |
| **after** | Full verify / `browser-e2e` | `.har/artifacts/browser-e2e/screenshots/after/` |

UI change tasks must add or update specs under `tests/frontend/` and **always**
include Playwright screenshot paths from the **session work dir** in the session
handoff (not the main checkout — see `CLAUDE.agent.md`). See `stages/PLAYWRIGHT.md`.

## Readiness layers

| Layer | Docs site meaning | Where |
|-------|-------------------|-------|
| Infra ready | No Docker — `setup-infra.sh` is a no-op | `HARNESS_INFRA_SERVICES=""` |
| Slot data ready | No per-slot DB / buckets | N/A |
| Process ready | `astro dev` up; `GET /` returns 200 | `launch.sh`, `verify.sh` |
| Agent usable | Landing hero HTML present; Playwright smoke + screenshots | `HARNESS_READINESS_CMD`, `browser-e2e` |

No seed/bootstrap is required — the site is static content + Astro.

**Skipped vs full local-dev:** production-like `astro preview` is not started;
agents use `astro dev` (dev toolbar disabled in `astro.config.mjs`). Full verify
still runs `astro build` and link checks.

## Run history

Every entry point — `./.har/*.sh`, `har env …`, MCP — runs the same packaged
runtime and writes the same records under the main checkout
`docs/.har/runs/YYYY-MM-DD/`. The shims delegate; they do not record less.

With worktree slots, code runs in the worktree; run JSON stays in the main
checkout `docs/.har/runs/`.

## For coding agents

1. Read root [`AGENTS.md`](../../AGENTS.md) (harness index) and [`docs/AGENTS.md`](../AGENTS.md)
2. Read this file and `stages.json`
3. After launch, read `CLAUDE.agent.md` for preview URL and screenshot paths

Always use `./.har/agent-cli.sh <id> ...` — never hardcode ports.

## Architecture

Each slot runs **only** the Astro site (`HARNESS_PRIMARY_APP=web`) on an
isolated port. No shared infra containers.

| Service | Agent 1 (default) | Agent 2 (default) |
|---------|-------------------|-------------------|
| Site (landing + docs) | 4321 | 4331 |
| Node debug | 9210 | 9220 |

`HARNESS_FE_BASE_PORT=4311` and `HARNESS_API_BASE_PORT=4311` — slot 1 defaults
to **4321** (`4311 + 1 × 10`). Same port for FE and API (single Astro process).

## Port & shared services

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Site | Per slot | `HARNESS_FE_BASE_PORT + (AGENT_ID × HARNESS_PORT_STEP)` | Scan `STEP` increments within the slot lane |
| Node debug | Per slot | `9200 + (AGENT_ID × STEP)` | Same scan policy |

No shared Postgres / MinIO / Mailpit / browser container ports — those services
are not enabled.

Always use `./.har/agent-cli.sh <id>` or `.har/slots/agent-<id>.json` — never
hardcode `4321` in app code or tests.

### Do not

- Hardcode ports in tests or docs — read `BASE_URL` / `.env.agent.<id>`
- Start Mission Control or the root CLI harness for docs-only UI work
- Hand-roll `astro dev` outside a launched slot when verifying live UI

### Monorepo port note

| Harness | Default slot-1 site port |
|---------|--------------------------|
| `docs/.har/` | 4321 |
| `control/.har/` | 3847 |
| `.har/` (CLI) | no PM2 app port |

These do not overlap by default.

## Maintaining this harness

```bash
cd docs
har env maintain
```

**Do not** put runtime behavior in YAML — edit the scripts directly.

## Session lifecycle

Every `launch` starts a **fresh session**: git worktree from the main checkout
HEAD at `~/worktrees/<base>-<sha4>-har-agent-<id>-<rand4>`, with work dir under
`…/docs`. Make ALL edits under the work dir printed by launch.

- Occupied slots block — `complete` / `teardown`, then `launch`
- `teardown` keeps the session branch
- `har env complete <id>` = full verify + validation + teardown (branch kept)

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
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated state** (don't edit — `har env eject` vendors `.har/runtime/`):

| File | Purpose |
|------|---------|
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

CLI and MCP are the only entry points. `har env eject` vendors the runtime into
`.har/runtime/` for offline ownership (`node .har/runtime/har.cjs env …`).

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
handoff (not the main checkout — see below). See `stages/PLAYWRIGHT.md`.

## Readiness layers

| Layer | Docs site meaning | Where |
|-------|-------------------|-------|
| Infra ready | No Docker — `har env setup-infra` is a no-op | `HARNESS_INFRA_SERVICES=""` |
| Slot data ready | No per-slot DB / buckets | N/A |
| Process ready | `astro dev` up; `GET /` returns 200 | `har env launch`, `har env verify` |
| Agent usable | Landing hero HTML present; Playwright smoke + screenshots | `HARNESS_READINESS_CMD`, `browser-e2e` |

No seed/bootstrap is required — the site is static content + Astro.

**Skipped vs full local-dev:** production-like `astro preview` is not started;
agents use `astro dev` (dev toolbar disabled in `astro.config.mjs`). Full verify
still runs `astro build` and link checks.

## Run history

Every entry point — `har env …`, MCP — runs the same packaged
runtime and writes the same records under the main checkout
`docs/.har/runs/YYYY-MM-DD/`. The shims delegate; they do not record less.

With worktree slots, code runs in the worktree; run JSON stays in the main
checkout `docs/.har/runs/`.

## For coding agents

1. Read root [`AGENTS.md`](../../AGENTS.md) (harness index) and [`docs/AGENTS.md`](../AGENTS.md)
2. Read this file and `stages.json`
3. After launch, this file has the preview URL and screenshot paths

Always use `har env agent <id>` — never hardcode ports.

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

Always use `har env agent <id>` or `.har/slots/agent-<id>.json` — never
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

## Environment

| | |
|--|--|
| **Site URL** | the slot URL (`har env agent <id> url`) |
| **Health** | the slot URL (`har env agent <id> url`)/ |
| **Work dir** | Fresh session worktree per launch — see launch output or `docs/.har/slots/agent-<id>.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under
the work dir from the launch output. Edits hot-reload via `astro dev`; use
`har env agent <id> restart` if a change doesn't take.

This slot runs **only** the Astro site (`HARNESS_PRIMARY_APP=web`). No database
or shared Docker infra.

```bash
har env agent <id> status
har env agent <id> logs web
har env agent <id> health
```

## Readiness — what “agent usable” means

1. **Process ready** — `har env agent <id> health` (HTTP 200 on `/`)
2. **Landing usable** — hero headline is present (wired as `HARNESS_READINESS_CMD`)
3. **Visual proof** — before/after screenshots exist under `.har/artifacts/…/screenshots/`
4. **No credentials** — the public site has no login; no seed data required

### Screenshot handoff (required for UI work)

| Phase | Path (under `docs/`) |
|-------|----------------------|
| before (launch baseline) | `.har/artifacts/browser-e2e/screenshots/before/` |
| after (full verify) | `.har/artifacts/browser-e2e/screenshots/after/` |

Typical files: `landing.png`, `docs-introduction.png`.

When you change the landing page or another route:

1. Add or update a Playwright spec under `tests/frontend/`
2. Update `tests/frontend/visual-proof.spec.cjs` if the route/assertion changed
3. Run `har env verify <id> --full`
4. In the session handoff, **always** link the **after** screenshots (and **before** when present) from the **session work dir** — not the main checkout (`docs/.har/artifacts/…` in the repo root stays stale)

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify <id> --full` or `har env verify <id> --full`)
- [ ] Site is agent-usable (health + readiness + screenshots), not only HTTP green
- [ ] UI changes have Playwright coverage; screenshot artifacts prove the result
- [ ] Changes committed **in the session worktree**
- [ ] User got the preview URL the slot URL (`har env agent <id> url`)
- [ ] Session handoff lists Playwright **after** screenshot paths from the work dir (`.har/artifacts/browser-e2e/screenshots/after/`)
- [ ] Present session handoff and **wait** before `complete`, push, or PR

### Session handoff

After full verify and commit, stop. Include summary, session branch
(`.har/slots/agent-<id>.json`), preview URL, and **Playwright after-screenshots**
(under `<work-dir>/.har/artifacts/browser-e2e/screenshots/after/` — always list the
PNG paths; the main checkout copy is not updated). Never autonomously run `complete`, push, or open a PR. Prefer **Complete + open a PR**
when `gh`/GitHub MCP is available.

Quick loop: `har env verify <id>` (check + health only).

## Project commands (in work dir)

```bash
npm run check       # astro check (quick verify)
npm run drift       # docs ↔ product contract drift
npm run build       # production build
npm run links       # link check (needs lychee on PATH for full local parity)
npm run test:e2e    # Playwright (prefer harness browser-e2e with slot BASE_URL)
```

## Do not

- Hand-roll `astro dev` — `launch` is how you run the site
- Work around a failing harness command with ad-hoc setup
- Hardcode ports — use agent env / `agent-cli.sh url`
- Edit the main checkout — all edits go under the session work dir
- Skip Playwright/screenshot updates when changing visible UI

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
- `har env complete <id>` = reuse last passing full validation + teardown (branch kept); `--verify` to re-run

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
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated state** (don't edit — `har env eject` vendors `.har/runtime/`):

| File | Purpose |
|------|---------|
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

CLI and MCP are the only entry points. `har env eject` vendors the runtime into
`.har/runtime/` for offline ownership (`node .har/runtime/har.cjs env …`).

Read **`stages.json`** and **`verificationStages`**. Browser E2E (Playwright) lives in [`control/.har/`](../control/.har/) — not this CLI harness.

## Verification contract

Verification is adapted for **@osfactory/har** — typecheck, build, docs site checks, and (full mode) unit tests, lint, and registered stages.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` | Typecheck, build, docs check/build |
| Full | `har env verify <id> --full` | + unit tests, lint, readiness, `docs-drift` |

This CLI harness has no runtime server — full verify is static analysis and tests only. A slot is **agent usable** when typecheck, build, docs check/build, unit tests, lint, and `docs-drift` pass. Mission Control dogfooding uses `control/.har/`; the docs site uses `docs/.har/`.

Use `har env launch 1 --no-worktree` only when working in the repo root.

## Run history

Every entry point — `har env …`, MCP — runs the same packaged
runtime and writes the same records under the main checkout
`.har/runs/YYYY-MM-DD/`.

With worktree slots, tests run in the worktree; run JSON lives in the main repo. See `workDir` in each record.

## For coding agents

**Start here:** read [`AGENTS.md`](../AGENTS.md) at the repo root for the workflow, then this file for the harness detail.

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown.

Work in the isolated git worktree created by launch. Use `har env agent <id> exec ...` to run ad-hoc project commands in that work dir.

When the project needs Postgres, Redis, or similar, add the service to `docker-compose.agent.yml`, list it in `HARNESS_INFRA_SERVICES` in `harness.env`, and use `har env setup-infra` — never run raw `docker compose` for shared infra.

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
| Per-slot databases | Cloned from template DB when `db` is enabled | `har env launch` |
| Application code | Isolated git worktree per slot | `HARNESS_USE_WORKTREE=true` |

### Do not

- Hardcode `15432` or other default infra ports in tests — read `AGENT_DB_PORT` from `.env.agent.<id>` or `har_pg`
- Run raw `docker compose` for harness infrastructure — use `har env setup-infra`

## Environment

| | |
|--|--|
| **Agent ID** | <id> |
| **Work dir** | Fresh session worktree per launch — see launch output or `.har/slots/agent-<id>.json` |
| **Infra** | None for this repo (`HARNESS_INFRA_SERVICES` is empty) |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

```bash
har env agent <id> status
har env agent <id> url
```

## Readiness / agent usable

This CLI harness has **no runtime server** — agents validate through static analysis and tests. A slot is **agent usable** when:

- The worktree has Node deps (root + `docs/`) from toolchain provisioning (`HARNESS_ECOSYSTEM` / `HARNESS_INSTALL_CMD`) and `.har/hooks/post-launch.sh`
- Quick verify passes: typecheck, build, docs check/build
- Full verify also passes unit tests, lint, and `docs-drift`

No `HARNESS_READINESS_CMD` is configured. Infra is unused (`HARNESS_INFRA_SERVICES` is empty).

For Mission Control (Next.js + SQLite) or the docs site (Astro), launch `control/.har/` or `docs/.har/` instead.

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify <id> --full`, MCP `har_run_verification` with `full: true`, or `har env verify <id> --full`)
- [ ] The slot is agent-usable: typecheck, build, docs check/build, unit tests, lint, and `docs-drift` all pass
- [ ] Full verify runs every registered stage in `stages.json` `verificationStages` (`docs-drift`)
- [ ] New behavior has automated test coverage
- [ ] Changes committed **in the session worktree** with a clear message
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

Quick loop: MCP `har_run_verification`, `har env verify <id>`, or `har env verify <id>`

Stages are the harness's single vocabulary for checks — interact through the registry (`har_run_stage`, `verify`), not stack-specific tooling. Authoring guide: `.har/STAGES.md`.

## Project commands

Run in the session work dir (or via `har env agent <id> exec`):

```bash
har env agent <id> exec npm test
har env agent <id> exec npm run typecheck
har env agent <id> exec npm run build
har env agent <id> exec sh -c 'cd docs && npm run check'
har env agent <id> exec sh -c 'cd docs && npm run drift'
```

Harness control-plane commands (MCP / `har env`) target the main repo checkout; project commands run in your work dir.

After changing `src/templates/`: `npm run build`, then test with a linked `har` install or `har env init --force --profile cli` on a fixture.

## Do not

- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.<id>` by hand
- Edit the main checkout — all edits go under the session work dir
- Run ad-hoc `npm test` from the repo root — use MCP/`har env verify` or `har env agent <id> exec`

## Architecture notes

See `AGENTS.md` for layer boundaries (`cli/` → `core/` → `harness/`). Put template changes in `src/templates/` and run `npm run build` before testing a linked `har` install.

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
- `har env complete <id>` finishes a session: reuses the last matching passing
  full validation, then teardown — branch kept. Pass `--verify` to re-run full
  verify if the tree may have changed.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

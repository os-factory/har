# .har — Agent Harness (CLI / library profile)

This directory is the **agent harness** for this repository. It lets AI coding agents run the project in isolated git worktrees with optional Docker-backed shared infra.

Generated and maintained by [`har`](https://github.com/your-org/har). Run `har env maintain` when the repo stack changes.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, profile, checksums) — do not edit |
| `harness.env` | Shared config: worktree default, infra flags, migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP only — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation (reads limits from `harness.env`) |
| `setup-infra.sh` | Start optional Docker Compose stack + template database |
| `launch.sh` | Launch one agent slot (git worktree by default, deps, env file) |
| `verify.sh` | Verification pipeline (typecheck, tests, lint, build) |
| `teardown.sh` | Tear down one agent slot (worktree + env file) |
| `agent-cli.sh` | Inspect slot status, run commands in the work dir |
| `docker-compose.agent.yml` | Shared infrastructure containers (when infra flags are enabled) |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

No PM2 or `ecosystem.agent.template.cjs` in this profile — agents run project commands directly in their worktree.

## Quick start

```bash
./.har/setup-infra.sh          # when infra flags are on
./.har/launch.sh 1
./.har/verify.sh 1
./.har/verify.sh 1 --full      # + lint, build, browser-e2e (if Playwright installed)
./.har/teardown.sh 1
```

Read **`stages.json`** and **`verificationStages`**. Optional: `har env add-stage playwright`.

## Verification contract

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `verify.sh <id>` | typecheck, unit tests |
| Full | `verify.sh <id> --full` | + lint, build, **browser-e2e** when `stages/browser-e2e.sh` exists |

Use `./.har/launch.sh 1 --no-worktree` only when working in the repo root.

## har CLI

```bash
har env launch 1
har env verify 1
har env teardown 1
```

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No |
| `har env …` / MCP | Yes — main checkout `.har/runs/YYYY-MM-DD/` |

With worktree slots, tests run in the worktree; run JSON lives in the main repo. See `workDir` in each record.

## For coding agents

**Start here:** read [`AGENT.md`](../AGENT.md) at the repo root for a short pointer, then [`.har/CLAUDE.agent.md`](./CLAUDE.agent.md) for full instructions.

Work in the isolated git worktree created by `launch.sh`. Use `./.har/agent-cli.sh <id> exec ...` to run project commands in that work dir.

When the project needs Postgres, MinIO, or similar, enable the matching `HARNESS_INFRA_*` flags in `harness.env` and use `setup-infra.sh` — never run raw `docker compose` for shared infra.

## Maintaining this harness

When the project stack changes (new test commands, database needs, env vars):

```bash
har env maintain
```

The authoring agent updates scripts and this README. Review changes before committing.

**Do not** put runtime behavior in YAML — edit the scripts directly.

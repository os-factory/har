# .har — Agent Harness (@dotharness/cli)

This directory is the **agent harness** for this repository. It lets AI coding agents run `@dotharness/cli` in isolated git worktrees with optional Docker-backed shared infra.

Generated and maintained by [`har`](https://github.com/antoineFrau/har). Run `har env maintain` when the repo stack changes.

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, profile, checksums) — do not edit |
| `harness.env` | Shared config: worktree default, infra flags, migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from `har env` / MCP — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
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
| `.cursor/rules/har-workflow.mdc` | (repo root) Cursor rule — auto-injects harness workflow; created/refreshed by `har env init/maintain` |

No PM2 in this profile — agents run project commands directly in their worktree.

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
# 1. Optional shared infrastructure (when HARNESS_INFRA_* flags are true)
./.har/setup-infra.sh

# 2. Launch agent 1 (creates ~/worktrees/har_project-agent-1 by default)
./.har/launch.sh 1

# 3. Check status
./.har/agent-cli.sh 1 status

# 4. Verify after changes
./.har/verify.sh 1

# 5. Tear down
./.har/teardown.sh 1
```

Use `har env launch 1 --no-worktree` or `./.har/launch.sh 1 --no-worktree` only when you intentionally want to work in the repo root checkout.

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No |
| `har env …` / MCP | Yes — `.har/runs/YYYY-MM-DD/` in this (main) checkout |

Worktree slots run code in `~/worktrees/har_project-agent-<id>`; run JSON stays here. See `AGENT.md` for details.

## For coding agents

**Start here:** read [`AGENT.md`](../AGENT.md) at the repo root, then [`.har/CLAUDE.agent.md`](./CLAUDE.agent.md).

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown — they persist run history. Use `./.har/*.sh` only when the CLI is not installed.

Work in the isolated git worktree created by launch. Use `./.har/agent-cli.sh <id> exec ...` for ad-hoc project commands in that work dir.

## Maintaining this harness

When the project stack changes:

```bash
har env maintain
```

Review changes before committing. Edit scripts directly — no YAML runtime config.

To create or refresh the Cursor rule:

```bash
har env maintain --cursor-rule     # force-write .cursor/rules/har-workflow.mdc
har env maintain --no-cursor-rule  # skip Cursor rule scaffolding
```

## Session lifecycle

Every `launch` starts a **fresh session**: a new git worktree from the current HEAD at
`~/worktrees/<base-branch>-<sha4>-har-agent-<id>-<rand4>`, on a branch of the same name.
The session is recorded in `.har/slots/agent-<id>.json` (the slot registry) — status,
verify, and teardown resolve the work dir through it. Make ALL file edits under the
work dir printed by launch, never in the main checkout.

- Relaunching a slot **replaces** its previous session; if the old worktree has
  uncommitted changes, launch refuses unless `--force`.
- `teardown` removes the worktree but **keeps the session branch** so you can push it
  or open a PR (`--delete-branch` to drop it).
- `har env complete <id>` finishes a session: full verify (recorded as a validation),
  then teardown — branch kept.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).

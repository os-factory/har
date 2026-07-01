# .har — Agent Harness (@har/cli)

This directory is the **agent harness** for this repository. It lets AI coding agents run `@har/cli` in isolated git worktrees with optional Docker-backed shared infra.

Generated and maintained by [`har`](https://github.com/your-org/har). Run `har env maintain` when the repo stack changes.

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

Use `./.har/launch.sh 1 --no-worktree` only when you intentionally want to work in the repo root checkout.

Or via the har CLI:

```bash
har env launch 1
har env verify 1
har env teardown 1
```

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No |
| `har env …` / MCP | Yes — `.har/runs/YYYY-MM-DD/` in this (main) checkout |

Worktree slots run code in `~/worktrees/har_project-agent-<id>`; run JSON stays here. See `AGENT.md` for details.

## For coding agents

**Start here:** read [`AGENT.md`](../AGENT.md) at the repo root, then [`.har/CLAUDE.agent.md`](./CLAUDE.agent.md).

Work in the isolated git worktree created by `launch.sh`. Use `./.har/agent-cli.sh <id> exec ...` for project commands in that work dir.

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

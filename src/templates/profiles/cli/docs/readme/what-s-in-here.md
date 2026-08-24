## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, profile, checksums) — do not edit |
| `harness.env` | Shared config: worktree default, `HARNESS_INFRA_SERVICES`, toolchain provisioning (`HARNESS_ECOSYSTEM`, `HARNESS_INSTALL_CMD`), migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from every entry point — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
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

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, checksums) — do not edit |
| `harness.env` | Shared config: primary app, ports, agent slot limits, `HARNESS_INFRA_SERVICES`, toolchain provisioning, migrate/seed commands |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from every entry point — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignore) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |
| `agent-slot.sh` | Shared agent-id validation (reads limits from `harness.env`) |
| `setup-infra.sh` | Start shared Docker infra + create template database |
| `launch.sh` | Launch one agent slot (ports, DB clone, toolchain provisioning, PM2 processes) |
| `provision-toolchain.sh` | Install deps and write toolchain paths to `.env.agent.<id>` |
| `verify.sh` | Verification pipeline (smoke by default; --full adds tests, lint, e2e) |
| `teardown.sh` | Tear down one agent slot |
| `agent-cli.sh` | Manage a running agent (status, logs, psql, health) |
| `attach.sh` | Attach to agent tmux session |
| `env.template` | Per-agent env vars (expanded by `launch.sh`) |
| `ecosystem.agent.template.cjs` | PM2 processes for the **primary app only** (expanded by `launch.sh`) |
| `ecosystem.shared.config.cjs` | Optional — shared app services started once by `setup-infra.sh` (only when the repo has supporting services) |
| `docker-compose.agent.yml` | Shared infrastructure containers |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

## What's in here

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `manifest.json` | Generator metadata (version, profile, checksums) — do not edit |
| `harness.env` | Shared config: Xcode scheme, simulator name, bundle ID, toolchain provisioning, infra flags |
| `stages.json` | Machine-readable registry of runnable harness stages |
| `stages/` | Optional custom stage scripts registered from `stages.json` |
| `runs/` | Run history from every entry point — gitignored |
| `artifacts/` | Stage outputs: test results, screenshots, logs |
| `setup-infra.sh` | Check the toolchain; start optional Docker services |
| `launch.sh` | Launch one agent slot — thin shim forwarding to `har env launch` |
| `verify.sh` | Verification pipeline (build smoke by default; --full adds tests, lint, flows) |
| `teardown.sh` | Tear down one agent slot (worktree + env file) |
| `agent-cli.sh` | Inspect slot status, run xcodebuild commands, install/launch app |
| `docker-compose.agent.yml` | Optional shared backend services |
| `CLAUDE.agent.md` | Detailed instructions for coding agents |
| `justfile` | Optional shortcuts (requires `just`) |

No PM2 or web-port wiring in this profile — agents run xcodebuild commands directly in their worktree.

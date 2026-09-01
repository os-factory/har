## What's in here

**Yours — the configuration surface** (edit freely; drift tracking records adaptations):

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `harness.env` | Schema-validated config: Xcode scheme, simulator name, bundle ID, toolchain provisioning, optional infra services |
| `stages.json` | Registered stages, verification tiers, artifacts, slot limits, gate policy |
| `stages/` | Project-owned stage scripts registered from `stages.json` |
| `hooks/` | Optional lifecycle hooks (`pre-launch.sh`, `post-launch.sh`, `pre-verify.sh`, `pre-teardown.sh`, `post-teardown.sh`) |
| `plugins/` | Optional local plugins (`har plugin create <id>`) |
| `docker-compose.agent.yml` | Optional shared backend services |
| `.har/README.md` | Detailed instructions for coding agents |
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated state** (don't edit — `har env eject` vendors `.har/runtime/`):

| File | Purpose |
|------|---------|
| `manifest.json` | Runtime version, profile, checksums — managed by the har CLI |
| `runs/` | Run history from every entry point — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignored) |
| `artifacts/` | Stage outputs: test results, screenshots, logs |

No PM2 or web-port wiring in this profile — agents run xcodebuild commands directly in their worktree.
## What's in here

**Yours — the configuration surface** (edit freely; drift tracking records adaptations):

| File | Purpose |
|------|---------|
| `README.md` | This file — index of the harness |
| `harness.env` | Schema-validated config: primary app, ports, agent slot limits, `HARNESS_INFRA_SERVICES`, toolchain provisioning, migrate/seed commands |
| `stages.json` | Registered stages, verification tiers, artifacts, slot limits, gate policy |
| `stages/` | Project-owned stage scripts registered from `stages.json` |
| `hooks/` | Optional lifecycle hooks (`pre-launch.sh`, `post-launch.sh`, `pre-verify.sh`, `pre-teardown.sh`, `post-teardown.sh`) |
| `plugins/` | Optional local plugins (`har plugin create <id>`) |
| `env.template` | Per-agent env vars (expanded into `.env.agent.<id>` at launch) |
| `ecosystem.agent.template.cjs` | PM2 processes for the **primary app only** (expanded at launch) |
| `ecosystem.shared.config.cjs` | Optional — shared app services started once with the infra (only when the repo has supporting services) |
| `docker-compose.agent.yml` | Shared infrastructure containers (services listed in `HARNESS_INFRA_SERVICES`) |
| `.har/README.md` | Detailed instructions for coding agents |
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated shims and state** (don't edit — `har env eject` for full ownership):

| File | Purpose |
|------|---------|
| `har env launch` / `har env verify` / `har env teardown` / `har env setup-infra` / `preflight.sh` / `agent-cli.sh` / `attach.sh` | Thin shims forwarding to the packaged runtime (`har env …`); same run records on every surface |
| `manifest.json` | Runtime version, profile, checksums — managed by the har CLI |
| `runs/` | Run history from every entry point — `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (gitignored) |
| `artifacts/` | Stage outputs: reports, traces, screenshots, logs |

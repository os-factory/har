<p align="center">
  <img src="logo.png" alt="har logo" width="120">
</p>

# har — Your AI harness orchestrator

[![Release](https://img.shields.io/github/v/release/os-factory/har)](https://github.com/os-factory/har/releases)
[![CI](https://github.com/os-factory/har/actions/workflows/test.yml/badge.svg)](https://github.com/os-factory/har/actions/workflows/test.yml)
[![Documentation](https://img.shields.io/badge/docs-harproject.cloud-38c976)](https://harproject.cloud/)

**Make any repository agent-ready without binding it to one coding agent, test runner, or hosted platform.**

HAR is an open-source CLI and MCP control plane for project-owned development harnesses. It scaffolds an editable `.har/` runtime contract so humans and MCP-capable coding agents can discover how to launch, verify, reset, inspect, and tear down a repository.

HAR does not own the coding LLM and does not replace CI/CD. It gives agents a stable, machine-readable way to use the workflow your team already trusts.

Planning tools decide what to build. HAR binds that durable work identity to an
isolated execution attempt and verifiable evidence: runs, artifacts, telemetry,
and the exact Git tree that passed.

## How It Works

1. **Project-owned harness** — `.har/` contains editable scripts, docs, environment metadata, logs, artifacts, and optional stage definitions.
2. **CLI control plane** — `har env ...` scaffolds, maintains, launches, verifies, reports status, and tears down local or self-hosted harness runs.
3. **MCP adapter** — agents use HAR MCP tools to describe the project, run generic stages, read logs, list artifacts, and inspect status without learning repo-specific shell details.
4. **Generic stages** — setup, launch, verify, test, inspect, reset, teardown, and custom stages expose normalized status, logs, durations, artifacts, and URLs.
5. **Configurable agent slots** — parallel environment limits are defined in `.har/stages.json` (`agentSlots`) and `.har/harness.env`, not by the HAR CLI.
6. **Optional stage templates** — add workflows like Playwright with `har env add-stage playwright`. They compile to generic stages (`test`, `custom`, etc.), not hardcoded HAR APIs.
7. **Durable work evidence** — optionally launch with `--work-id` so slot sessions, retries, cost, and exact-tree validations remain attributable after teardown.

## Install

**From npm:**

```bash
npm install -g @osfactory/har@latest
```

**From source:**

```bash
git clone https://github.com/os-factory/har har-project && cd har-project
npm install && npm run build && npm link
```

Read the [full documentation](https://harproject.cloud/). See [AGENT.md](./AGENT.md) for architecture and coding-agent guidance, and [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development workflow, testing on sample projects, and project layout. To report security issues, see [SECURITY.md](./SECURITY.md).

## Harness profiles

`har env init` scaffolds `.har/` from a boilerplate profile. Pick the one that matches what agents need to run — you only choose this once at init time.

| Profile | Best for | What you get |
|---------|----------|--------------|
| `default` | Web apps (Next.js, Rails, Django, etc.) | Docker Compose for shared infra, PM2 for the primary app, per-slot ports and preview URLs |
| `cli` | CLI tools, libraries, npm packages | No PM2 or port wiring — agents run project commands in an isolated git worktree; optional Docker for databases |
| `ios` | iOS / Swift mobile apps | xcodebuild + iOS Simulator; configure scheme, project, and simulator in `harness.env` |

```bash
# Web app (default — omit --profile)
cd my-web-app && har env init

# CLI tool or library
cd my-cli && har env init --profile cli

# iOS app
cd MyApp && har env init --profile ios
har env add-stage rocketsim   # optional: UI flow validation on the simulator
```

After init, paste the printed adaptation prompt into your coding agent to tailor scripts to your stack. For built-in Claude adaptation: `har env init --auto` (requires `ANTHROPIC_API_KEY`).

Optional stage templates depend on the profile: `har env add-stage playwright` for browser E2E on web apps, `har env add-stage rocketsim` for simulator user-flow checks on iOS.

## Quick start

```bash
cd my-app
har env init                  # or --profile cli / --profile ios

# Paste the printed prompt into your coding agent to adapt .har/ and AGENT.md
git add .har/ AGENT.md
git commit -m "Add agent harness"

har env launch 1
har env verify 1
```

To correlate execution with an issue or ticket:

```bash
har env launch 1 --work-id "github:acme/widget#123" --work-source github
har env complete 1
```

Shell fallback when the CLI is not installed: `./.har/setup-infra.sh`, `./.har/launch.sh 1`, `./.har/verify.sh 1`.

See [Harness profiles](#harness-profiles) above if your repo is a CLI/library or iOS app rather than a web app.

## Agent skills (/setup-har, /har-wt, /har-maintain)

`har env init` can scaffold **project-owned skills/commands** for coding agents, so the har workflow is one slash command away for every teammate who clones the repo:

| Skill | Who invokes it | What it does |
|-------|----------------|--------------|
| `/setup-har` | You, once | Installs har if missing, picks a profile, runs `har env init`, performs the adaptation prompt itself, proves launch + verify, commits |
| `/har-wt` | The agent, on every coding task | Launches a harness slot, does all edits in the session worktree (never the main checkout), verifies through the harness |
| `/har-maintain` | You, when the harness drifts | Runs `har env maintain`, applies the adaptation, finalizes and re-verifies |

Targets are auto-detected at `init`/`maintain` (or forced with `--agents claude,cursor,codex`); you can also manage them standalone:

```bash
har agents install --claude --cursor   # .claude/skills/ + .cursor/commands/ (committed to the repo)
har agents install --codex             # ~/.codex/prompts/ (global — Codex has no per-repo prompts)
har agents remove --claude
```

Scaffolded files carry a `managed by har` header and are refreshed by `har env maintain`; files you edit by hand are left alone.

**Optional enforcement (Claude Code):** make `/har-wt` self-triggering instead of memory-dependent —

```bash
har hooks install --claude
```

installs a `PreToolUse` guard (`.har/hooks/claude-worktree-guard.sh` + an entry in `.claude/settings.json`) that blocks `Edit`/`Write` in the **main checkout** of a har repo and points the agent to `/har-wt`. Edits inside session worktrees pass through. Remove with `har hooks uninstall --claude`; humans can bypass with `HAR_SKIP_WT_GUARD=1`.

## Repo layout after init

```
my-app/
├── AGENT.md                 # Short pointer for coding agents (you approve this)
└── .har/
    ├── README.md            # Full harness documentation (maintained by har)
    ├── manifest.json        # Generator metadata
    ├── stages.json          # Optional generic stage registry
    ├── setup-infra.sh
    ├── launch.sh
    ├── verify.sh
    ├── agent-cli.sh
    ├── logs/
    ├── artifacts/
    ├── harness.env
    ├── CLAUDE.agent.md
    └── ...
```

## Generic Stage Contract

HAR stages are project-defined operations with stable identifiers and normalized results. A stage can be as simple as `verify` or as specific as `browser-e2e`, `migration-check`, `accessibility`, or `load-smoke`.

The important boundary is that HAR runs and reports stages generically. It does not need a special Playwright, migration, accessibility, or load-test API in the core product. The authoring contract (command vs script stages, the script contract, how `verificationStages` controls `verify --full`) ships into every harness as `.har/STAGES.md`.

### Custom stages

Register the project's real checks so they run in `verify --full` and surface to every agent:

```bash
har env add-stage unit-tests --custom --kind test --command "npm test" --verification
har env add-stage db-integrity --custom --script   # scaffolds .har/stages/db-integrity.sh
```

### Playwright (optional)

```bash
har env init
har env add-stage playwright   # registers browser-e2e + scaffolds tests/
npm install && npx playwright install
./.har/launch.sh 1
./.har/stages/browser-e2e.sh 1
```

See `.har/stages/PLAYWRIGHT.md` in the target repo after applying the template.

## CLI commands

| Command | Description |
|---------|-------------|
| `har env init` | Scaffold `.har/` + print coding-agent adaptation prompt |
| `har env add-stage playwright` | Add a stage template (`playwright`, `rocketsim`; `--list` shows all) |
| `har env add-stage <id> --custom` | Register a project-specific stage (`--command "npm test"` or `--script`) |
| `har env maintain` | Validate harness + print maintenance prompt |
| `har env launch 1` | Launch agent slot 1 |
| `har env verify 1` | Run verification |
| `har env status` | Show status for all agent slots (`--json` for structured output) |
| `har env runs list` | List persisted run history (`--json`) |
| `har env runs get <runId>` | Fetch one run record |
| `har env teardown 1` | Tear down agent slot 1 |
| `har agents install` | Scaffold agent skills (`/setup-har`, `/har-wt`, `/har-maintain`) for Claude Code / Cursor / Codex |
| `har agents remove` | Remove har-managed agent skill files |
| `har hooks install` | Install the git commit gate (`--claude` for the Claude Code worktree guard) |
| `har control up` | Start local Mission Control dashboard (Docker Compose) |
| `har control register` | Register a repo with Mission Control |
| `har control sync` | Sync runs + slot status to Mission Control |
| `har control watch` | Continuously sync registered repos |
| `har mcp` | Start the HAR MCP server (stdio) |

Options: `--force`, `--auto` (built-in Claude adaptation), `--smoke`, `--yes` (auto-apply AGENT.md with `--auto`), `--verbose`, `--profile <default|cli|ios>`

## MCP Surface

Start the server from a repository (or pass `repo` on each tool call):

```bash
har mcp
```

Example Cursor MCP config:

```json
{
  "mcpServers": {
    "har": {
      "command": "har",
      "args": ["mcp", "--repo", "/path/to/my-app"]
    }
  }
}
```

Core tools (generic — no stack-specific operations like `run_playwright`):

| Tool | Purpose |
|------|---------|
| `har_describe_project` | Manifest, scripts, stages, agent slot limits, stack hints |
| `har_init_harness` | Scaffold `.har/` (optionally skip LLM) |
| `har_launch_environment` | Launch slot; return preview URLs |
| `har_run_stage` | Run one stage by id or kind |
| `har_run_verification` | Run the verification pipeline |
| `har_get_status` | Slot/process status |
| `har_get_logs` | Recent logs for a slot |
| `har_teardown_environment` | Stop a slot |
| `har_list_artifacts` | List files under `.har/artifacts/` |
| `har_list_runs` | List persisted run records from `.har/runs/` |
| `har_get_run` | Fetch one run record by `runId` |

## Mission Control (local dashboard)

Free OSS dashboard for observing harness runs, worktrees, and agent slots on your machine:

```bash
har control up          # pulls theosfactory/har-control:<cli-version> + Postgres at http://localhost:3847
har env init            # remembers the repo for sync when Control starts
har control sync        # push runs + slot status
```

**Do not run `har control up` and `cd control && har env launch 1` on port 3847 at the same time.** Use the harness for agent dev (hot reload); use `har control up` for the packaged Docker dashboard. Preflight on each side detects the conflict and suggests `har control down` or an alternate harness slot/port.

See [`control/AGENT.md`](./control/AGENT.md) for dashboard development. Hosted team features are **HAR Cloud** (paid).

Agents can still use GitHub, Linear, observability, and other MCP servers directly. HAR focuses on the repository harness and run state.

## HAR Cloud

The open-source CLI and MCP harness are the core. Paid HAR Cloud should add hosted operational value that teams do not want to build themselves:

- Hosted branch previews and remote harness runs
- Run history, logs, artifacts, screenshots, traces, and result timelines
- QA handoff, approvals, and shareable preview links
- Slack, Linear, GitHub, and observability integrations
- Team dashboards for status, policy, audit trails, and cost controls

HAR Cloud should coordinate and observe the factory. The repo-owned `.har/` contract remains portable.

## For Coding Agents

Agents should read **`AGENT.md`** first, then **`.har/README.md`**. Prefer **HAR MCP tools** (in Cursor) or **`har env …`** for launch, verify, and teardown — they persist run history. Use `./.har/*.sh` only when the CLI is not installed.

## License

**Dual licensing.** This project uses different licenses for code, documentation, and branding.

| Material | License | Details |
|----------|---------|---------|
| Software (CLI, MCP server, Mission Control code, tooling) | [AGPL-3.0-only](./LICENSE) | Copyleft; network use (SaaS) triggers source-offer obligations |
| Documentation and written guides | [CC BY-SA 4.0](./DOCUMENTATION-LICENSE.md) | Share and adapt with attribution and share-alike |
| Name, logo, trademarks | All rights reserved | See [TRADEMARK.md](./TRADEMARK.md) |

**Commercial use without AGPL obligations** — closed-source products, managed hosting, training/certification programs, trademark use, or other rights beyond the public licenses require a separate agreement. See [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).

Copyright © 2026 [Antoine Frau](https://github.com/antoineFrau/har).

Contributors agree to the [Contributor License Agreement](./CLA.md).

**Note:** Earlier releases may have been published under MIT. Those versions remain under MIT; new releases from this license change forward are under AGPL-3.0-only unless you obtain a commercial license.

## Security

Report vulnerabilities via [SECURITY.md](./SECURITY.md) (GitHub private advisory preferred).

Inspired by [Lightdash's agent-harness](https://github.com/lightdash/lightdash/tree/main/agent-harness).

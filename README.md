<p align="center">
  <img src="logo.png" alt="har logo" width="120">
</p>

# har — Your AI harness orchestrator

[![Release](https://img.shields.io/github/v/release/os-factory/har)](https://github.com/os-factory/har/releases)
[![CI](https://github.com/os-factory/har/actions/workflows/test.yml/badge.svg)](https://github.com/os-factory/har/actions/workflows/test.yml)

**Make any repository agent-ready without binding it to one coding agent, test runner, or hosted platform.**

HAR is an open-source CLI and MCP control plane for project-owned development harnesses. It scaffolds an editable `.har/` runtime contract so humans and MCP-capable coding agents can discover how to launch, verify, reset, inspect, and tear down a repository.

HAR does not own the coding LLM and does not replace CI/CD. It gives agents a stable, machine-readable way to use the workflow your team already trusts.

## How It Works

1. **Project-owned harness** — `.har/` contains editable scripts, docs, environment metadata, logs, artifacts, and optional stage definitions.
2. **CLI control plane** — `har env ...` scaffolds, maintains, launches, verifies, reports status, and tears down local or self-hosted harness runs.
3. **MCP adapter** — agents use HAR MCP tools to describe the project, run generic stages, read logs, list artifacts, and inspect status without learning repo-specific shell details.
4. **Generic stages** — setup, launch, verify, test, inspect, reset, teardown, and custom stages expose normalized status, logs, durations, artifacts, and URLs.
5. **Configurable agent slots** — parallel environment limits are defined in `.har/stages.json` (`agentSlots`) and `.har/harness.env`, not by the HAR CLI.
6. **Optional stage templates** — add workflows like Playwright with `har env add-stage playwright`. They compile to generic stages (`test`, `custom`, etc.), not hardcoded HAR APIs.

## Install

**From npm** (end users):

```bash
npm install -g @har/cli
```

**From source** (local development):

```bash
git clone https://github.com/os-factory/har har-project && cd har-project
npm install && npm run build && npm link
```

See [AGENT.md](./AGENT.md) for architecture and coding-agent guidance, and [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development workflow, testing on sample projects, and project layout. To report security issues, see [SECURITY.md](./SECURITY.md).

## Quick start

```bash
cd my-app
har env init

# Paste the printed prompt into your coding agent to adapt .har/ and AGENT.md
git add .har/ AGENT.md
git commit -m "Add agent harness"

har env launch 1
har env verify 1
```

Shell fallback when the CLI is not installed: `./.har/setup-infra.sh`, `./.har/launch.sh 1`, `./.har/verify.sh 1`.

For built-in Claude adaptation (requires `ANTHROPIC_API_KEY`): `har env init --auto`.

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

The important boundary is that HAR runs and reports stages generically. It does not need a special Playwright, migration, accessibility, or load-test API in the core product.

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
| `har env add-stage playwright` | Add Playwright `browser-e2e` stage + test scaffold |
| `har env maintain` | Validate harness + print maintenance prompt |
| `har env launch 1` | Launch agent slot 1 |
| `har env verify 1` | Run verification |
| `har env status` | Show status for all agent slots (`--json` for structured output) |
| `har env runs list` | List persisted run history (`--json`) |
| `har env runs get <runId>` | Fetch one run record |
| `har env teardown 1` | Tear down agent slot 1 |
| `har control up` | Start local Mission Control dashboard (Docker Compose) |
| `har control register` | Register a repo with Mission Control |
| `har control sync` | Sync runs + slot status to Mission Control |
| `har control watch` | Continuously sync registered repos |
| `har mcp` | Start the HAR MCP server (stdio) |

Options: `--force`, `--auto` (built-in Claude adaptation), `--smoke`, `--yes` (auto-apply AGENT.md with `--auto`), `--verbose`, `--profile cli`

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
har control up          # starts Postgres + dashboard at http://localhost:3847
har env init            # auto-registers when Control is running
har control sync        # push runs + slot status
```

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

MIT — see [LICENSE](./LICENSE).

## Security

Report vulnerabilities via [SECURITY.md](./SECURITY.md) (GitHub private advisory preferred).

Inspired by [Lightdash's agent-harness](https://github.com/lightdash/lightdash/tree/main/agent-harness).

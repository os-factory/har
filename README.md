# har — OSS CLI + MCP Harness

**Make any repository agent-ready without binding it to one coding agent, test runner, or hosted platform.**

HAR is an open-source CLI and MCP control plane for project-owned development harnesses. It scaffolds an editable `.har/` runtime contract so humans and MCP-capable coding agents can discover how to launch, verify, reset, inspect, and tear down a repository.

HAR does not own the coding LLM and does not replace CI/CD. It gives agents a stable, machine-readable way to use the workflow your team already trusts.

## How It Works

1. **Project-owned harness** — `.har/` contains editable scripts, docs, environment metadata, logs, artifacts, and optional stage definitions.
2. **CLI control plane** — `har env ...` scaffolds, maintains, launches, verifies, reports status, and tears down local or self-hosted harness runs.
3. **MCP adapter** — agents use HAR MCP tools to describe the project, run generic stages, read logs, list artifacts, and inspect status without learning repo-specific shell details.
4. **Generic stages** — setup, launch, verify, test, inspect, reset, teardown, and custom stages expose normalized status, logs, durations, artifacts, and URLs.
5. **Configurable agent slots** — parallel environment limits are defined in `.har/stages.json` (`agentSlots`) and `.har/harness.env`, not by the HAR CLI.
6. **Optional templates** — Playwright, migration checks, accessibility scans, load smoke tests, API checks, and similar workflows are stage templates, not hardcoded HAR concepts.

## Install

**From npm** (end users):

```bash
npm install -g @har/cli
```

**From source** (local development):

```bash
git clone <repo-url> har-project && cd har-project
npm install && npm run build && npm link
```

See [AGENT.md](./AGENT.md) for architecture and coding-agent guidance, and [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development workflow, testing on sample projects, and project layout.

## Quick start

```bash
export ANTHROPIC_API_KEY=your_key

cd my-app
har env init

# Review and apply proposed AGENT.md when prompted
git add .har/ AGENT.md
git commit -m "Add agent harness"

./.har/setup-infra.sh
./.har/launch.sh 1
./.har/verify.sh 1
```

To try the CLI on a sample repo without LLM-assisted adaptation: `har env init --skip-llm`.

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

## CLI commands

| Command | Description |
|---------|-------------|
| `har env init` | Scaffold `.har/` + LLM adaptation + AGENT.md proposal |
| `har env maintain` | Update harness + README + AGENT.md proposal |
| `har env launch 1` | Launch agent slot 1 |
| `har env verify 1` | Run verification |
| `har env status` | Show status for all agent slots |
| `har env teardown 1` | Tear down agent slot 1 |
| `har mcp` | Start the HAR MCP server (stdio) |

Options: `--force`, `--skip-llm`, `--smoke`, `--yes` (auto-apply AGENT.md), `--verbose`

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

Agents should read **`AGENT.md`** first, then **`.har/README.md`**. They run `./.har/*` scripts — not `har` CLI directly during coding.

Inspired by [Lightdash's agent-harness](https://github.com/lightdash/lightdash/tree/main/agent-harness).

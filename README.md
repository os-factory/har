<p align="center">
  <img src="logo.png" alt="HAR logo" width="120">
</p>

# HAR — Harnesses for coding agents

[![Release](https://img.shields.io/github/v/release/os-factory/har)](https://github.com/os-factory/har/releases)
[![CI](https://github.com/os-factory/har/actions/workflows/test.yml/badge.svg)](https://github.com/os-factory/har/actions/workflows/test.yml)
[![Documentation](https://img.shields.io/badge/docs-harproject.dev-38c976)](https://harproject.dev/)

**Give coding agents a real place to work.**

HAR is an open-source, agent-agnostic standard for building multi-agent coding workflows. It makes your repository agent-ready, so you can run a whole fleet of coding agents in parallel, with deterministic validation gates, verifiable proof, and full observability across every agent.

Works with **Claude Code** · **Cursor** · **Codex** · any MCP agent.

## Install

```bash
npm install -g @osfactory/har
```

## Get started

```bash
cd my-app
har env init              # scaffold .har/ and print a prompt for your coding agent
har env launch 1          # isolated worktree + running stack for agent slot 1
har env verify 1 --full   # run the project's real checks, record what passed
```

That’s it. Your agents discover launch, verify, and teardown through the project’s `.har/` contract — not by guessing shell commands.

Full walkthrough: [Quick start](https://harproject.dev/docs/getting-started/quick-start/).

## How it works

1. **Discover** — The agent reads one stable interface instead of guessing project-specific shell commands.
2. **Isolate** — Every task gets a clean slot: dedicated session worktree, ports, and local services.
3. **Build** — The agent edits inside the harness, without touching the main checkout.
4. **Verify** — Project checks become a deterministic pipeline with normalized status, logs, and artifacts.
5. **Hand off** — Reviewers get a branch plus evidence: what ran and the exact validated tree.

## Why HAR

- **Project-owned** — The workflow lives with the code, not inside a vendor dashboard.
- **Agent-agnostic** — One stable contract for CLI users, MCP agents, and future tools.
- **Evidence-first** — Every run can leave logs, artifacts, status, and a validated tree hash.

## What HAR is not

- A coding model
- A replacement for CI/CD
- A new test runner
- A hosted platform lock-in

HAR coordinates the work around the model so agents can focus on the code — and reviewers can trust the result.

## Documentation

Everything beyond install and first commands lives at **[https://harproject.dev/](https://harproject.dev/)**:

- [Introduction](https://harproject.dev/docs/getting-started/introduction/) · [Core concepts](https://harproject.dev/docs/getting-started/concepts/)
- [CLI reference](https://harproject.dev/docs/reference/cli/) · [MCP tools](https://harproject.dev/docs/reference/mcp/)
- [Mission Control](https://harproject.dev/docs/guides/mission-control/) · [Architecture](https://harproject.dev/docs/project/architecture/)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, the dogfood harness loop, and architecture. Coding agents working on this repo should start with [AGENT.md](./AGENT.md). Maintainer release process: [RELEASING.md](./RELEASING.md).

## License

Licensed under the [Apache License 2.0](./LICENSE).

Copyright © 2026 [Antoine Frau](https://github.com/antoineFrau).

## Security

Report vulnerabilities via [SECURITY.md](./SECURITY.md).

<p align="center">
  <img src="logo.png" alt="HAR logo" width="120">
</p>

# HAR — Harnesses for coding agents

[![Release](https://img.shields.io/github/v/release/os-factory/har)](https://github.com/os-factory/har/releases)
[![CI](https://github.com/os-factory/har/actions/workflows/test.yml/badge.svg)](https://github.com/os-factory/har/actions/workflows/test.yml)
[![Documentation](https://img.shields.io/badge/docs-harproject.cloud-38c976)](https://harproject.cloud/)

**Give coding agents a real place to work.**

HAR turns any repository into a reproducible workspace with isolated worktrees, project-owned commands, and evidence that changes actually pass.

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

Full walkthrough: [Quick start](https://harproject.cloud/docs/getting-started/quick-start/).

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

Everything beyond install and first commands lives at **[https://harproject.cloud/](https://harproject.cloud/)**:

- [Introduction](https://harproject.cloud/docs/getting-started/introduction/) · [Core concepts](https://harproject.cloud/docs/getting-started/concepts/)
- [CLI reference](https://harproject.cloud/docs/reference/cli/) · [MCP tools](https://harproject.cloud/docs/reference/mcp/)
- [Mission Control](https://harproject.cloud/docs/guides/mission-control/) · [Architecture](https://harproject.cloud/docs/project/architecture/)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, the dogfood harness loop, and architecture. Coding agents working on this repo should start with [AGENT.md](./AGENT.md). Maintainer release process: [RELEASING.md](./RELEASING.md).

## License

Software is [AGPL-3.0-only](./LICENSE). Documentation is [CC BY-SA 4.0](./DOCUMENTATION-LICENSE.md). Trademarks are reserved — see [TRADEMARK.md](./TRADEMARK.md). Commercial use without AGPL obligations needs a separate agreement — see [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).

Copyright © 2026 [Antoine Frau](https://github.com/antoineFrau). Contributors agree to the [CLA](./CLA.md).

## Security

Report vulnerabilities via [SECURITY.md](./SECURITY.md).

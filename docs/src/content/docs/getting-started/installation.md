---
title: Installation
description: Install HAR, verify the CLI, and connect an MCP client.
---

## Requirements

- Node.js 20 or newer
- npm
- Git
- Docker only when your harness uses containerized infrastructure
- `ANTHROPIC_API_KEY` only for built-in `--auto` adaptation

## Install from npm

```bash
npm install -g @osfactory/har@latest
har --version
```

HAR's CLI, MCP server, bundled harness profiles, and Mission Control launcher ship
in the same `@osfactory/har` package.

## Install from source

```bash
git clone https://github.com/os-factory/har.git
cd har
npm install
npm run build
npm link
```

Re-run `npm run build` after source changes. Remove the global link with:

```bash
npm unlink -g @osfactory/har
```

## Connect an MCP client

Start HAR as a stdio MCP server:

```bash
har mcp --repo /absolute/path/to/your/repository
```

For clients that accept JSON MCP configuration:

```json
{
  "mcpServers": {
    "har": {
      "command": "har",
      "args": ["mcp", "--repo", "/absolute/path/to/your/repository"]
    }
  }
}
```

The configured repository is the default. Every MCP tool also accepts a `repo`
argument, so one server can operate another harness explicitly.

## Upgrade

```bash
npm install -g @osfactory/har@latest
har env maintain
```

Updating the package never silently overwrites an adapted `.har/` directory. Use
`maintain` to inspect template drift and apply updates deliberately.

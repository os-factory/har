---
title: Installation
description: Install HAR, verify the CLI, and connect an MCP client.
---

## Requirements

- Node.js 20 or newer
- npm
- Git
- **Docker** — required. Mission Control runs as a container (`har control up`) and
  harness profiles start shared infrastructure through Docker Compose
  (`.har/setup-infra.sh`). Install it from
  [docs.docker.com](https://docs.docker.com/get-started/get-docker/) and make sure
  the daemon is running before you onboard.

`har onboard` and `har env init` probe Docker on start and warn when the CLI is
missing or the daemon is down. Onboarding still completes without Docker, but it
will not offer to start Mission Control until Docker is available.

## Install from npm

```bash
npm install -g @osfactory/har@latest
har --version
```

HAR's CLI, MCP server, bundled harness profiles, and Mission Control launcher ship
in the same `@osfactory/har` package.

Install activates **full agent telemetry by default** (traces, logs, metrics, and
prompts → local Mission Control). Preference is written to `~/.har/telemetry.json`
when missing. Disable with `har telemetry off`, or keep usage without prompt text
via `har telemetry on --no-prompts`. For a guided first-run in a repository
(including telemetry and Mission Control choices), use `har onboard`.

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

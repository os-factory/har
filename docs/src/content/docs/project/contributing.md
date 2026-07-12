---
title: Contributing
description: Develop and validate HAR itself.
---

## Setup

```bash
git clone https://github.com/os-factory/har.git
cd har
npm install
npm run build
```

Node.js 20 or newer is required. Docker is required for Mission Control and fixture
harnesses that use shared infrastructure.

## Use HAR to develop HAR

The repository dogfoods two harnesses:

| Harness | Owns |
| --- | --- |
| root `.har/` (`cli` profile) | CLI, MCP, schemas, templates, and tests |
| `control/.har/` (`default` profile) | Mission Control Next.js app and browser tests |

Launch the harness that owns the files before editing:

```bash
har env launch 1
```

Make all edits in its returned work directory. Full verification is required before
declaring work complete:

```bash
har env verify 1 --full
```

## Development commands

The root package provides `build`, `dev`, `test`, `test:watch`, `typecheck`, and
`lint`. Run them through the active harness or its `agent-cli.sh` helper.

Template changes require a rebuild before testing because the build copies
`src/templates/` and authoring prompts into `dist/`.

## Tests

Root Jest tests live under `tests/` and use fixture harnesses instead of real Docker
where possible. Keep CLI/MCP parity tests when adapters share a core path.

Mission Control uses Vitest and Playwright under `control/`. UI behavior should have
browser coverage in the control harness.

## Pull requests and releases

Use Conventional Commits. `fix:` produces a patch, `feat:` a minor, and a breaking
change a major release. Documentation, CI, tests, and refactors do not publish a
package by themselves.

On releasable changes, semantic-release verifies the CLI and dashboard, aligns the
CLI/control/schema versions, publishes `@osfactory/har`, creates a GitHub release,
and publishes matching Mission Control Docker tags.

Read the repository's `CONTRIBUTING.md`, Code of Conduct, CLA, security policy, and
license files before submitting changes.

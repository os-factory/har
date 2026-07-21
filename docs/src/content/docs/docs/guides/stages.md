---
title: Stages and artifacts
description: Expose project-specific operations through HAR's generic stage contract.
---

## Define a stage

Stages are registered in `.har/stages.json`:

```jsonc
{
  "id": "migration-check",
  "kind": "test",
  "description": "Apply migrations to an empty database",
  "script": "stages/migration-check.sh",
  "requiresAgentId": true,
  "group": "database",
  "acceptsArgs": ["--from"],
  "artifacts": [
    {
      "path": ".har/artifacts/migration-check",
      "kind": "report",
      "description": "Migration report"
    }
  ]
}
```

A stage has an `id`, `kind`, and either `script` (relative to `.har/`) or `command`.
Other fields are `description`, `cwd`, `env`, `resultPath`, `requiresAgentId`,
`group`, `acceptsArgs`, and `artifacts`. `{agentId}` is expanded in commands at
execution.

Kinds are `setup`, `launch`, `verify`, `test`, `inspect`, `reset`, `teardown`, and
`custom`. Artifact kinds are `file`, `directory`, `log`, `report`, `screenshot`,
`trace`, `video`, and `url`.

## Add a custom stage

For a simple command:

```bash
har env add-stage unit-tests-fast --custom --kind test \
  --command "npm test" --verification
```

For a workflow that needs slot environment, ports, or artifacts:

```bash
har env add-stage db-integrity --custom --script \
  --description "Check database invariants" --verification
```

The script form scaffolds `.har/stages/db-integrity.sh` from HAR's normalized
stage contract. Every generated harness includes the complete authoring guide at
`.har/STAGES.md`.

## Run a stage

MCP-capable agents use the generic stage tool:

```text
har_run_stage({ stageId: "migration-check", agentId: 1 })
```

The MCP tool can select by `stageId` or generic `kind` and can pass an argument
array. The result normalizes status, timing, logs, errors, artifacts, and URLs.

Humans can run the project-owned script directly:

```bash
./.har/stages/migration-check.sh 1
```

## Verification stages

Repositories may declare the stage ids that constitute verification:

```json
{
  "verificationStages": ["typecheck", "unit", "browser-e2e"]
}
```

Full verification runs registered `test` and `custom` stages listed in
`verificationStages`. Lifecycle and `verify` stages are never nested into
verification. IDs without a registered stage remain inline steps owned by
`.har/verify.sh`. Mission Control uses the same list to render the expected pipeline.

## List shipped templates

```bash
har env add-stage --list
```

## Playwright template

```bash
har env add-stage playwright
```

This adds:

- a `browser-e2e` test stage;
- Playwright configuration;
- frontend, API health, and accessibility smoke specs;
- CI workflow and artifact directories unless `--skip-ci` is used.

Adapt selectors and URLs after installation. Full verification automatically invokes
the browser stage when `.har/stages/browser-e2e.sh` exists.

## RocketSim template

```bash
har env add-stage rocketsim
```

This installs a `rocketsim-flows` runner, authoring guidance, and an example iOS
flow. RocketSim itself and a booted simulator are external requirements.

## Custom stages

Do not wait for a HAR-specific integration. Add shell scripts for domain workflows
such as:

- migration compatibility;
- contract or integration tests;
- accessibility checks;
- visual regression;
- load smoke tests;
- fixture reset;
- log collection.

Keeping the core generic makes those workflows usable from the CLI, MCP, CI, and
Mission Control without adding stack-specific APIs.

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
`group`, `acceptsArgs`, `tier`, and `artifacts`. `{agentId}` is expanded in
commands at execution. `tier` (`"quick"` or `"full"`, default `"full"`) controls
whether a verification stage runs on every `har env verify` or only on `--full`.

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

`verificationStages` is the pipeline: every id must resolve to a registered
`test` or `custom` stage, and the list order is the execution order. Quick
verification (`har env verify <id>`) runs the stages marked `tier: "quick"`;
`--full` runs the whole list. The ecosystem defaults (`typecheck`, `unit-tests`,
`lint`, `readiness`, and `api-health` on web profiles) are ordinary registered
stages written at init from `HARNESS_ECOSYSTEM` — there are no inline steps.
Unresolvable ids are reported by validation and skipped with a warning at run
time. Lifecycle and `verify` stages are never nested into verification. Mission
Control uses the same list to render the expected pipeline.

## Install plugins

Framework integrations (Playwright, RocketSim, Kerno, Gitleaks, Trivy, Semgrep, …)
ship as **plugins**. They install files and register stages — agents still only
talk to the stage registry.

```bash
har env add-plugin --list
har env add-plugin playwright
har env add-plugin rocketsim
har env add-plugin kerno
har env add-plugin gitleaks
har env add-plugin trivy
har env add-plugin semgrep
```

See [Plugins](/docs/guides/plugins/) for details.

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

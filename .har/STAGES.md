# HAR Stages — authoring guide

> **This monorepo:** root `.har/` is the CLI profile (no Playwright). Browser E2E is registered in [`control/.har/stages.json`](../control/.har/stages.json).

Stages are the harness's single vocabulary for runnable checks and lifecycle
actions. Everything — shipped plugins (`playwright`, `rocketsim`, `kerno`, `gitleaks`, `trivy`, `semgrep`), your
project's test/lint commands, bespoke validation scripts — registers in
`.har/stages.json` with the same schema, and agents interact with stages only
through that registry (CLI `har env verify`, MCP `har_run_stage` /
`har_run_verification`), never through stack-specific tooling.

Philosophy: *plugins install stages; agents only talk to the stage registry.*

## The registry: `.har/stages.json`

```jsonc
{
  "verificationStages": ["typecheck", "unit-tests", "api-health", "browser-e2e"],
  "stages": [
    {
      "id": "browser-e2e",              // stable, shell-friendly slug
      "kind": "test",                   // setup | launch | verify | test | inspect | reset | teardown | custom
      "description": "Playwright E2E",
      "script": "stages/browser-e2e.sh", // relative to .har/ — OR use "command"
      "requiresAgentId": true,           // default true for test/verify/custom kinds
      "artifacts": [{ "path": ".har/artifacts/browser-e2e", "kind": "directory" }]
    },
    {
      "id": "unit-tests-fast",
      "kind": "test",
      "command": "npm test -- --agent {agentId}"   // {agentId} is substituted at run time
    }
  ]
}
```

Optional stage fields: `cwd` (working directory), `env` (extra env vars),
`group`, `acceptsArgs` (extra CLI args the stage accepts, e.g. `["--full"]`).

## Two ways to define a stage

**Command stages** — the default for simple checks (`npm test`, `swiftlint`,
`make check`). One JSON entry, zero files:

```bash
har env add-stage unit-tests-fast --custom --kind test --command "npm test" --verification
```

**Script stages** — for anything that needs the slot's env, ports, or
artifacts. Scaffold a contract-compliant skeleton:

```bash
har env add-stage db-integrity --custom --script --description "Check DB invariants"
```

then implement the TODO block in `.har/stages/db-integrity.sh`.

## The stage script contract

Every script under `.har/stages/` must:

1. Assume the 1.0 stage surface: the runner exports `WORK_DIR`, `ENV_FILE`,
   `AGENT_ID` and `HAR_HARNESS_DIR`, with `harness.env` and the slot env file
   already sourced. Never source `agent-slot.sh` — it is retired in 1.0.
2. Take the agent slot id as `$1`, falling back to the exported `AGENT_ID`
   (`AGENT_ID="${1:-${AGENT_ID:?...}}"`); extra args may follow.
3. Guard the runner contract with `${ENV_FILE:?...}` / `${WORK_DIR:?...}`
   (pointing at `./.har/launch.sh <id>`) and run checks from `$WORK_DIR`.
4. Write artifacts (reports, screenshots, logs) under `.har/artifacts/<id>/`.
5. Print **only** the normalized JSON result object on stdout
   (`status`, `stageId`, `agent_id`, `total_ms`, …); log progress to stderr.
6. Exit with the real status code (0 = pass).

The scaffolded skeleton implements all of this — replace its TODO block.

## Verification membership

Listing a stage id in `verificationStages` is what includes it in
`har env verify <id> --full`. Ids that match a registered stage run via their
script/command; ids without a registry entry (e.g. `typecheck`, `api-health`)
are inline steps owned by `.har/verify.sh`. Lifecycle kinds
(`setup`/`launch`/`reset`/`teardown`/`inspect`) and `verify` itself never run
as part of verification, even if listed.

## Commit gate

The registry also holds the optional `commitGate` config (installed via
`har hooks install`): `{ "commitGate": { "mode": "block" | "warn", "scope":
"worktrees" | "all" } }` controls whether unverified change batches may be
committed.

## Shipped plugins

`har env add-plugin --list` shows available plugins; `har env add-plugin
playwright` (web), `har env add-plugin rocketsim` (iOS), or `har env
add-plugin kerno` (backend), `har env add-plugin gitleaks` (secrets scanning, any
stack), or `har env add-plugin trivy` (dependency + IaC security scan, any stack),
or `har env add-plugin semgrep` (SAST, any stack)
installs one. A
plugin is just packaging: it copies files, merges `package.json` fragments,
and registers stages through the exact same registry as `add-stage --custom`.

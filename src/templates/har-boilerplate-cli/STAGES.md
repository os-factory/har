# HAR Stages — authoring guide

Stages are the harness's single vocabulary for runnable checks and lifecycle
actions. Everything — shipped templates (`playwright`, `rocketsim`), your
project's test/lint commands, bespoke validation scripts — registers in
`.har/stages.json` with the same schema, and agents interact with stages only
through that registry (CLI `har env verify`, MCP `har_run_stage` /
`har_run_verification`), never through stack-specific tooling.

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

1. Source `harness.env` and `agent-slot.sh` from `.har/`.
2. Take the agent slot id as `$1` (validate with `validate_agent_id`); extra
   args may follow.
3. Load the slot env via `resolve_agent_env_file` and run checks from the
   agent's work dir (`resolve_agent_work_dir`).
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

## Shipped stage templates

`har env add-stage --list` shows available templates; `har env add-stage
playwright` (web) or `har env add-stage rocketsim` (iOS) installs one. A
template is just packaging: it copies files, merges `package.json` fragments,
and registers stages through the exact same registry as `--custom`.

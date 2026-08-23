# HAR Stages — authoring guide

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

1. Source `harness.env` and `agent-slot.sh` from `.har/`. Before sourcing,
   set `SCRIPT_DIR` to the `.har/` directory (not `stages/`) — `agent-slot.sh`
   resolves the slot registry via `$SCRIPT_DIR/slots/...`.
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

`verificationStages` is the single namespace for the verification pipeline:
every id listed must resolve to a registered stage of kind `test` or `custom`,
and the list order is the execution order. There are no inline steps — the
ecosystem defaults (`typecheck`, `unit-tests`, `lint`, `readiness`, and
`api-health` on web profiles) are ordinary registered stages, written at init
from `HARNESS_ECOSYSTEM`.

Each stage may declare `"tier": "quick" | "full"` (default `full`). Plain
`har env verify <id>` runs the `quick`-tier stages; `--full` runs the whole
list. Unresolvable ids are reported by validation (and `har env doctor`) and
skipped with a warning at run time. Lifecycle kinds
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

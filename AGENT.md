# HAR — Agent Development Guide

Guide for coding agents working on **this repository** (`@har/cli` — the CLI and MCP control plane).

For setup, testing fixtures, and PR workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

This repo **dogfoods HAR** — `.har/` at the repo root defines how coding agents validate changes here.

## Harness workflow (dogfooding)

After making changes, validate through the harness (not ad-hoc shell commands):

```bash
./.har/launch.sh 1          # once per session — worktree + deps + .env.agent.1
./.har/verify.sh 1          # typecheck + unit tests (fast)
./.har/verify.sh 1 --full   # + lint + build (before declaring done)
./.har/teardown.sh 1        # cleanup when finished
```

Or via the CLI:

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

Work happens in an isolated git worktree by default (`~/worktrees/<project>-agent-<id>`). Use `./.har/launch.sh 1 --no-worktree` only when you must use the repo root checkout.

MCP (Cursor): configured in [`.cursor/mcp.json`](.cursor/mcp.json) — agents can call `har_run_stage` with `verify` instead of running npm directly.

See [`.har/README.md`](.har/README.md) for harness details.

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No — same behavior, no run record |
| `har env launch/verify/...` | Yes |
| MCP `har_run_*` | Yes |

Run records are stored under the **main checkout** `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (local date/time). With worktree slots, tests run in the worktree but run JSON stays in the main repo; each record includes a `workDir` field.

Prefer `har env verify 1` when you want persisted run history. Use `./.har/verify.sh 1` for fast agent workflows without recording.

If your IDE workspace is a worktree, pass `--repo /path/to/main/checkout` to `har env` commands.

## Upgrading HAR

```bash
npm install -g @har/cli@latest    # updates CLI/MCP/run storage only
har env maintain                  # drift report + adaptation prompt
# apply updates via coding agent or: har env maintain --auto
./.har/verify.sh 1 --full
```

Do not use `har env init --force` on an adapted harness — it wipes customizations. See [CONTRIBUTING.md](./CONTRIBUTING.md#upgrading-har).

## Architecture

HAR is a layered CLI + MCP control plane. Business logic lives in `core/` and `harness/`. `cli/` and `mcp/` are thin adapters: parse input, call core, format output.

```
cli/  mcp/          ← adapters (flags, JSON, MCP tool schemas)
  ↓
core/               ← orchestration, public execution API
  ↓
harness/            ← .har/ contract, schemas, manifest/stages I/O
  ↓
utils/              ← generic helpers (shell, paths, logging)
```

`llm/` is the optional authoring agent for `har env init --auto` and `har env maintain --auto`. `templates/` holds scaffold assets copied into target repos — not runtime logic.

## Dependency rules

These are non-negotiable. Do not introduce imports that violate them.

| Layer | May import | Must not import |
|-------|------------|-----------------|
| `cli/`, `mcp/` | `core/`, `harness/`, `utils/` | each other |
| `core/` | `harness/`, `utils/`, `llm/` | `cli/`, `mcp/` |
| `harness/` | `utils/` | `core/`, `cli/`, `mcp/`, `llm/` |
| `utils/` | other `utils/` | anything with HAR domain concepts |
| `llm/` | `harness/`, `utils/` | `core/`, `cli/`, `mcp/` |

## Where to put changes

| Change | Location |
|--------|----------|
| Schema, stage kinds, result shapes | `src/harness/schema.ts` |
| Manifest / stages.json I/O | `src/harness/manifest.ts`, `stages.ts` |
| Scaffold copy, boilerplate wiring | `src/harness/generator.ts` |
| Init / maintain / describe orchestration | `src/core/harness.ts` |
| Run orchestration (launch, verify, teardown) | `src/core/run-service.ts` |
| Local bash/script execution | `src/core/local-executor.ts` |
| Run history (`.har/runs/`) | `src/core/runs.ts` |
| Shared execution types, `StageExecutor` | `src/core/types.ts` |
| CLI subcommand or flag | `src/cli/commands/` |
| MCP tool handler or JSON Schema | `src/mcp/server.ts`, `schemas.ts` |
| Files copied into target `.har/` | `src/templates/har-boilerplate/` |
| Optional stage templates | `src/templates/stage-templates/` (applied via `har env add-stage`) |
| Generic shell/path/logging helper | `src/utils/` |

When unsure: put domain logic in `harness/` or `core/`, never in an adapter.

## Public API

Adapters and tests import execution from **`src/core/run-service.ts`** (or the `run.ts` re-export). Do not import `local-executor.ts` from outside `core/`.

Canonical schemas live in **`src/harness/schema.ts`**. Parse CLI and MCP inputs at the boundary with Zod (`.parse()` / `.safeParse()`); infer types with `z.infer`.

Const arrays like `HAR_STAGE_KINDS` are the single source of truth — use them for Zod enums, MCP JSON Schema, and tests.

## Extension points

Design for a closed core with open seams — do not build a full plugin registry until there is a concrete second implementation.

- **`StageExecutor`** (`src/core/types.ts`) — swap local vs cloud execution by injecting a different executor into `RunService`. `local-executor.ts` is the current implementation.
- **Project-owned stages** — runtime behavior lives in the target repo's `.har/` scripts and `stages.json`, not as hardcoded tool APIs in core.
- **Stage templates** — optional bundles applied with `har env add-stage <template>` (e.g. `playwright` → `browser-e2e` stage + test scaffold). They compile down to generic stage kinds (`setup`, `launch`, `verify`, `test`, `custom`, etc.). Do not add stack-specific MCP tools like `run_playwright`.

## Anti-patterns

- Orchestration logic in `mcp/server.ts` or `cli/commands/` — adapters delegate to `core/`
- Stack-specific stages or MCP tools in core (Playwright, Cypress, migrations, etc.)
- `harness/` importing from `core/` — keeps the contract layer independent
- Domain types or HAR concepts in `utils/`
- Deep barrel re-exports inside `src/` — prefer explicit imports; public surface is `run-service.ts` / `run.ts`
- Weakening `strict: true` or using `any` instead of `unknown` + Zod narrowing

## Tests

- Unit tests in `tests/*.test.ts`; fixtures under `tests/fixtures/`
- Mock `.har/` layouts with fixtures — avoid real Docker in unit tests
- When CLI and core share a code path, keep parity tests (see `tests/run-service-parity.test.ts`)
- After changes: run the harness verify stage (see below)

## Before finishing

```bash
./.har/launch.sh 1              # if not already launched this session
./.har/verify.sh 1              # typecheck + unit tests
./.har/verify.sh 1 --full       # + lint + build — required before declaring done
```

If you changed `src/templates/`: `npm run build`, then `har env init --force --profile cli` on a fixture (or `--profile default` for web apps).

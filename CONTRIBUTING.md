# Contributing to har

Guide for developing the CLI locally and testing it against real (or sample) repositories.

**Coding agents:** read [AGENT.md](./AGENT.md) first for architecture rules, where to put changes, and extension points. This file covers setup, workflow, and PR details.

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js ≥ 20**
- **npm**
- **`ANTHROPIC_API_KEY`** — required only for `--auto` on `har env init` / `har env maintain`
- **Docker** — optional; needed when running harness scripts (`setup-infra.sh`, `launch.sh`, etc.) on projects that use containers

## Setup

```bash
git clone https://github.com/os-factory/har har-project
cd har-project
npm install
npm run build
```

### Cursor MCP (optional)

To use HAR tools from Cursor (`har_launch_environment`, `har_run_verification`, etc.), install the CLI globally (`npm link` or `npm install -g .`), then create a local MCP config:

```bash
cp .cursor/mcp.json.example .cursor/mcp.json
```

Edit `.cursor/mcp.json` and replace `/path/to/your/checkout` with the absolute path to your clone of this repo. The file is gitignored — each contributor keeps their own copy.

Restart Cursor (or reload MCP servers) after creating or changing the file.

## Running the CLI locally

Pick one of these approaches:

### `npm link` (recommended)

Links the built CLI globally so you can run `har` from anywhere:

```bash
npm link
har --version
```

After code changes, rebuild:

```bash
npm run build
```

### `npm run dev` (fast iteration)

Runs the TypeScript source directly via `tsx` — no build step:

```bash
npm run dev -- env init --repo /path/to/project
npm run dev -- env --help
```

### Install from the local checkout

```bash
npm install -g .
```

Same as a global npm install, but from your working tree. Re-run after rebuilding.

### Run the built binary directly

```bash
node dist/index.js env init --repo /path/to/project
```

### Unlink when done

```bash
npm unlink -g @har/cli
```

## Development loop

| Command | Purpose |
|---------|---------|
| `npm run build` | Bundle CLI to `dist/index.js` and copy templates + prompts |
| `npm run dev -- <args>` | Run CLI from source without building |
| `npm test` | Run Jest tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`) |
| `npm run lint` | ESLint on `src/` |

The build step bundles TypeScript with esbuild and copies:

- `src/templates/` → `dist/templates/`
- `src/llm/prompts/*.md` → `dist/prompts/`

If you change templates or prompts, rebuild before testing a linked install.

## Testing on a project

### Quick test (no API key)

Scaffold boilerplate and print the coding-agent adaptation prompt:

```bash
cd /path/to/your-project
har env init
```

For CLI/library repos (no PM2; optional Docker via `harness.env` infra flags):

```bash
har env init --profile cli
```

This creates `.har/` with scripts and config. Validation will warn about TODO placeholders in `harness.env` and `verify.sh` until you paste the prompt into your coding agent (or edit manually).

### Full test (with built-in Claude adaptation)

```bash
export ANTHROPIC_API_KEY=your_key
cd /path/to/your-project
har env init --auto
```

The CLI will copy the boilerplate, call Claude to adapt it to the repo, and propose `AGENT.md` at the repo root. Apply the proposal when prompted, or pass `--yes` to auto-apply.

### Useful flags

| Flag | Purpose |
|------|---------|
| `--repo <path>` | Target a project without changing directory |
| `--auto` | Run built-in Claude adaptation (requires API key) |
| `--force` | Overwrite an existing `.har/` |
| `--yes` | Auto-apply the `AGENT.md` proposal (with `--auto`) |
| `--smoke` | Run `setup-infra.sh` after init |
| `--verbose` | Extra logging |
| `--no-control` | Skip Mission Control registration on `har env init` |

### Mission Control dashboard

Local observability UI (Next.js + shadcn/ui + Postgres):

```bash
har control up
# open http://localhost:3847

cd control && npm run dev   # dashboard development without Docker app image
```

See [`control/AGENT.md`](./control/AGENT.md).

### Sample fixtures

The repo includes minimal apps under `tests/fixtures/`:

| Fixture | Stack | Notes |
|---------|-------|-------|
| `go-gin-pg/` | Go + Gin + PostgreSQL | Clean — no `.har/` yet |
| `python-fastapi-pg/` | Python + FastAPI + PostgreSQL | Clean |
| `node-react-pg/` | Node + Express + PostgreSQL | May already have `.har/` — use `--force` or another fixture |

Copy a fixture to a temp directory to avoid modifying the repo:

```bash
cp -r tests/fixtures/go-gin-pg /tmp/har-test
cd /tmp/har-test
har env init
```

### After init — run the harness

**Preferred — har CLI or MCP** (persists run history):

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
har env status
```

In Cursor: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment`.

**Shell fallback** (no CLI/MCP installed):

```bash
./.har/setup-infra.sh
./.har/launch.sh 1
./.har/verify.sh 1
./.har/teardown.sh 1
```

## Upgrading HAR

When a new `@har/cli` release changes harness templates or run storage:

```bash
npm install -g @har/cli@latest    # updates CLI/MCP/run storage — does not touch project .har/
har env maintain                  # validation + drift report + adaptation prompt
# apply updates with your coding agent (paste .har/ADAPT-PROMPT.md) or: har env maintain --auto
har env verify 1 --full
```

| Command | Effect | Risk |
|---------|--------|------|
| `npm install -g @har/cli@latest` | New run layout, MCP, core behavior | Safe for `.har/` |
| `har env maintain` | Drift report vs bundled templates | Safe — in-place |
| `har env init --force` | Replaces entire `.har/` | **Destructive** — loses customizations |

Do not use `har env init --force` on an adapted project harness.

## Project layout

```
src/
├── index.ts                 # Entry point
├── cli/
│   ├── index.ts             # yargs setup
│   └── commands/            # env.ts, mcp.ts
├── core/
│   ├── harness.ts           # init, maintain, describe
│   ├── run-service.ts       # Public execution API (CLI/MCP import this)
│   ├── local-executor.ts    # Local bash/script stage runner
│   ├── runs.ts              # Local run history (.har/runs/)
│   ├── results.ts           # Normalized stage result parsing
│   ├── types.ts             # ExecutionContext, StageExecutor, shared types
│   └── run.ts               # Re-exports from run-service (compat)
├── harness/
│   ├── generator.ts         # Copy boilerplate into .har/
│   ├── drift.ts             # Compare .har/ to bundled templates
│   ├── manifest.ts          # manifest.json read/write
│   ├── stages.ts            # stages.json registry I/O
│   ├── validator.ts         # Post-scaffold validation + smoke tests
│   ├── parser.ts            # harness presence helpers
│   ├── agent-md.ts          # AGENT.md proposal flow
│   └── schema.ts            # Canonical Zod schemas
├── mcp/
│   ├── server.ts            # MCP tool handlers
│   ├── schemas.ts           # MCP input/output Zod schemas
│   └── schema-tools.ts      # Shared JSON Schema helpers
├── llm/
│   ├── authoring-agent.ts   # Claude agent for repo adaptation
│   ├── tools.ts             # LLM tool definitions
│   └── prompts/             # System prompts (copied to dist/ on build)
├── templates/
│   ├── har-boilerplate/     # Files copied into target .har/
│   └── AGENT.md.template    # Template for root AGENT.md proposal
└── utils/                   # File ops, shell, logging, validation

tests/
├── fixtures/                # minimal-harness, node-react-pg, go-gin-pg, ...
└── *.test.ts                # Unit/integration tests
```

## TypeScript conventions

- **Zod at boundaries** — canonical schemas live in `src/harness/schema.ts`. Parse CLI/MCP inputs with `.parse()` / `.safeParse()`; infer types with `z.infer`.
- **`strict: true` always** — do not weaken compiler settings in `tsconfig.json`.
- **Prefer `unknown` over `any`** — narrow with Zod or type guards before use.
- **Const arrays for enums** — e.g. `HAR_STAGE_KINDS` drives Zod, MCP JSON Schema, and tests from one source.
- **Core vs adapters** — business logic in `src/core/` and `src/harness/`; `cli/` and `mcp/` handle argument parsing and formatting only.
- **Dependency direction** — `harness/` must not import from `core/` or `mcp/`; `utils/` stays generic.
- **Explicit public API** — import execution from `src/core/run-service.ts` (or `run.ts` re-export).
- **Fixture-first tests** — mock `.har/` scripts under `tests/fixtures/minimal-harness/`; avoid real Docker in unit tests.
- **Parity tests** — when legacy wrappers delegate to `runStage`, keep tests that both paths behave the same.
- **Run `npm run typecheck`, `npm run lint`, and `npm test`** before opening a PR.

## Making changes

### Templates (`src/templates/har-boilerplate/`)

These files are copied verbatim into a target repo's `.har/` on `har env init`. After editing:

1. Run `npm run build`
2. Test with `har env init --force --profile cli` on a fixture

Placeholders like `__PROJECT_NAME__` in `harness.env` are substituted during scaffold.

### LLM prompts (`src/llm/prompts/`)

System prompts for the optional `--auto` authoring agent. Rebuild to copy them into `dist/prompts/`. Test with `har env init --auto` (requires API key).

### CLI commands

Add or modify subcommands in `src/cli/commands/env.ts` and register them in the yargs builder there.

### Tests

Jest is configured to pick up `tests/**/*.test.ts`. Add unit tests alongside fixtures as the test suite grows.

## Pull requests

Before opening a PR:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Describe how you tested (e.g. `har env init` on `go-gin-pg` fixture).

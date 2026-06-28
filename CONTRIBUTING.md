# Contributing to har

Guide for developing the CLI locally and testing it against real (or sample) repositories.

**Coding agents:** read [AGENT.md](./AGENT.md) first for architecture rules, where to put changes, and extension points. This file covers setup, workflow, and PR details.

## Prerequisites

- **Node.js ≥ 20**
- **npm**
- **`ANTHROPIC_API_KEY`** — required for LLM adaptation (`har env init` / `har env maintain` without `--skip-llm`)
- **Docker** — optional; needed when running harness scripts (`setup-infra.sh`, `launch.sh`, etc.) on projects that use containers

## Setup

```bash
git clone <repo-url> har-project
cd har-project
npm install
npm run build
```

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
npm run dev -- env init --repo /path/to/project --skip-llm
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

Scaffold boilerplate only — useful for verifying the copy/validate path:

```bash
cd /path/to/your-project
har env init --skip-llm
```

For CLI/library repos (no Docker/PM2):

```bash
har env init --skip-llm --profile cli
```

This creates `.har/` with scripts and config. Validation will warn about TODO placeholders in `harness.env` and `verify.sh` until the LLM adapts them (or you edit them manually).

### Full test (with LLM adaptation)

```bash
export ANTHROPIC_API_KEY=your_key
cd /path/to/your-project
har env init
```

The CLI will copy the boilerplate, call Claude to adapt it to the repo, and propose `AGENT.md` at the repo root. Apply the proposal when prompted, or pass `--yes` to auto-apply.

### Useful flags

| Flag | Purpose |
|------|---------|
| `--repo <path>` | Target a project without changing directory |
| `--skip-llm` | Copy boilerplate only; no API call |
| `--force` | Overwrite an existing `.har/` |
| `--yes` | Auto-apply the `AGENT.md` proposal |
| `--smoke` | Run `setup-infra.sh` after init |
| `--verbose` | Extra logging |

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
har env init --skip-llm
```

### After init — run the harness

Either use the shell scripts directly (what coding agents do):

```bash
./.har/setup-infra.sh
./.har/launch.sh 1
./.har/verify.sh 1
./.har/teardown.sh 1
```

Or use the CLI wrappers:

```bash
har env launch 1
har env verify 1
har env teardown 1
har env status
```

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
2. Test with `har env init --force --skip-llm` on a fixture

Placeholders like `__PROJECT_NAME__` in `harness.env` are substituted during scaffold.

### LLM prompts (`src/llm/prompts/`)

System prompts for the authoring agent. Rebuild to copy them into `dist/prompts/`. Test with a full `har env init` (requires API key).

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

Describe how you tested (e.g. `har env init --skip-llm` on `go-gin-pg` fixture).

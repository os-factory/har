# Contributing to har

Guide for developing the CLI locally and testing it against real (or sample) repositories.

**Coding agents:** read [AGENT.md](./AGENT.md) first for architecture rules, where to put changes, and extension points. This file covers setup, the dogfood harness loop, workflow, and PR details.

**Maintainers:** release pipeline, npm/Docker secrets, and version coupling live in [RELEASING.md](./RELEASING.md).

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

By submitting a pull request or other contribution, you agree to the [Contributor License Agreement](./CLA.md), which grants the maintainer rights needed for dual licensing (public AGPL and separate commercial licenses).

## Prerequisites

- **Node.js ≥ 20**
- **npm**
- **`ANTHROPIC_API_KEY`** — required only for `--auto` on `har env init` / `har env maintain`
- **Docker** — optional; needed when running harness scripts on projects that use containers, and for `har control up`

## Setup

```bash
git clone https://github.com/os-factory/har.git
cd har
npm install
npm run build
```

### Cursor MCP (optional)

To use HAR tools from Cursor (`har_launch_environment`, `har_run_verification`, etc.), install the CLI globally (`npm link` or `npm install -g .`), then create a local MCP config:

```bash
cp .cursor/mcp.json.example .cursor/mcp.json
```

Edit `.cursor/mcp.json` and replace `/path/to/your-checkout` with the absolute path to your clone of this repo. The file is gitignored — each contributor keeps their own copy.

Restart Cursor (or reload MCP servers) after creating or changing the file.

## How HAR works

HAR is a layered CLI + MCP control plane. Business logic lives in `core/` and `harness/`. `cli/` and `mcp/` are thin adapters: parse input, call core, format output.

```
cli/  mcp/          ← adapters (flags, JSON, MCP tool schemas)
  ↓
core/               ← orchestration, public execution API (run-service.ts)
  ↓
harness/            ← .har/ contract, schemas, manifest/stages I/O
  ↓
utils/              ← generic helpers (shell, paths, logging)
```

`llm/` is the optional authoring agent for `har env init --auto` and `har env maintain --auto`. `templates/` holds scaffold assets copied into target repos — not runtime logic.

Canonical schemas live in [`packages/schemas/src/schema.ts`](packages/schemas/src/schema.ts) and are re-exported by [`src/harness/schema.ts`](src/harness/schema.ts).

### Dependency rules

| Layer | May import | Must not import |
|-------|------------|-----------------|
| `cli/`, `mcp/` | `core/`, `harness/`, `utils/` | each other |
| `core/` | `harness/`, `utils/`, `llm/` | `cli/`, `mcp/` |
| `harness/` | `utils/` | `core/`, `cli/`, `mcp/`, `llm/` |
| `utils/` | other `utils/` | anything with HAR domain concepts |
| `llm/` | `harness/`, `utils/` | `core/`, `cli/`, `mcp/` |

### Concepts you will hit often

| Concept | Meaning | Primary code |
|---------|---------|--------------|
| **Slot** | Numbered agent environment (1..N) with its own ports/env | [`src/core/slot-registry.ts`](src/core/slot-registry.ts) |
| **Session worktree** | Isolated git worktree created on `launch`; all edits go here | [`src/core/run-service.ts`](src/core/run-service.ts) + `.har/launch.sh` |
| **Stage** | Project-defined runnable step (`launch`, `verify`, `test`, …) | [`src/harness/stages.ts`](src/harness/stages.ts) |
| **Validation** | Tree-hash record written after a passing full verify | [`src/core/validations.ts`](src/core/validations.ts) |
| **Commit gate** | Git hooks that block commits unless the staged tree matches a validation | [`src/core/hooks.ts`](src/core/hooks.ts) |

## Use HAR to develop HAR

This repository **dogfoods** HAR. Prefer the harness over ad-hoc shell commands.

| Harness | Profile | Use when changing |
|---------|---------|-------------------|
| [`.har/`](.har/) | `cli` | `src/`, `packages/`, `tests/`, root docs |
| [`control/.har/`](control/.har/) | `default` | `control/` Mission Control app |

Run harness commands from the directory that owns the harness (e.g. `cd control` for Mission Control).

### Required loop

1. **Launch before editing** — `har env launch 1` (or `./.har/launch.sh 1`). Launch creates a fresh session worktree and prints its **work dir**.
2. **Edit only in that work dir** — never in the main checkout. Changes there hot-reload for running slots when applicable.
3. **Verify through the harness** — `har env verify 1` (fast) then `har env verify 1 --full` before declaring done.
4. **Commit in the session worktree** — if the commit gate is installed, commits that do not match a passing full-verify validation are blocked.
5. **Complete or teardown when finished** — `har env complete 1` (full verify + validation + teardown) or `har env teardown 1`. The session **branch is kept** so you can push a PR.

```bash
har env launch 1
# make ALL edits under the printed work dir
har env verify 1
har env verify 1 --full
har env complete 1
```

Shell fallback when the CLI is not installed: `./.har/launch.sh 1`, `./.har/verify.sh 1 --full`, `./.har/teardown.sh 1`.

In Cursor, prefer MCP tools (`har_launch_environment`, `har_run_verification`, `har_complete_environment`) once [`.cursor/mcp.json`](.cursor/mcp.json.example) points at your checkout.

### Commit gate

With `har hooks install`, `git commit` is blocked unless the staged tree matches a state that passed full verify (a tree hash under `.har/validations/`). Any edit after verify requires re-running `har env verify <id> --full`. Stage everything you verified (`git add -A`); do not bypass the gate (`--no-verify`, `HAR_SKIP_GATE=1`).

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

### Run the built binary directly

```bash
node dist/index.js env init --repo /path/to/project
```

### Unlink when done

```bash
npm unlink -g @osfactory/har
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
| `npm run drift --prefix docs` | Docs contract check (CLI/MCP/schemas vs docs site) |

The build step bundles TypeScript with esbuild and copies:

- `src/templates/` → `dist/templates/`
- `src/llm/prompts/*.md` → `dist/prompts/`

If you change templates or prompts, rebuild before testing a linked install.

### Docs drift

Full verify runs `docs-drift` (`npm run drift --prefix docs`). Changing public CLI commands, MCP tools, stage kinds, plugins, or skill IDs without updating the docs site will fail verification. Fix the docs under `docs/src/content/docs/` (and keep [docs/check-drift.mjs](docs/check-drift.mjs) green).

## CLI surface

Top-level command groups (see `har <cmd> --help`):

| Command | Purpose |
|---------|---------|
| `har env …` | Harness lifecycle (init, maintain, launch, verify, complete, …) |
| `har agents …` | Scaffold/remove agent skills (`/setup-har`, `/har-wt`, `/har-maintain`) |
| `har control …` | Local Mission Control dashboard |
| `har hooks …` | Commit gate and Claude worktree guard |
| `har mcp` | MCP stdio server |
| `har preferences …` | User onboarding defaults (`~/.har/preferences.json`) |
| `har telemetry …` | Agent usage telemetry via `@osfactory/otel-hook` |

## Testing on a project

### Quick test (no API key)

```bash
cd /path/to/your-project
har env init
```

For CLI/library repos:

```bash
har env init --profile cli
```

### Full test (with built-in Claude adaptation)

```bash
export ANTHROPIC_API_KEY=your_key
cd /path/to/your-project
har env init --auto
```

### Useful flags

| Flag | Purpose |
|------|---------|
| `--repo <path>` | Target a project without changing directory |
| `--auto` | Run built-in Claude adaptation (requires API key) |
| `--force` | Overwrite an existing `.har/` |
| `--yes` | Auto-apply the `AGENT.md` proposal (with `--auto`) |
| `--smoke` | Run `setup-infra.sh` after init |
| `--verbose` | Extra logging |
| `--profile <default\|cli\|ios>` | Choose harness boilerplate |

### Mission Control dashboard

```bash
har control up          # pulls theosfactory/har-control:<cli-version> from Docker Hub
har control up --build  # build locally from source (monorepo contributors)
# open http://localhost:3847

cd control && npm run dev   # dashboard development without Docker app image
```

**Port 3847** is shared by `har control up` (Docker) and Mission Control harness slot 1 (`cd control && har env launch 1`). Do not run both at once on the default port:

- **Agent dev** (hot reload, worktrees): `cd control && har env launch 1`
- **Packaged dashboard** (Docker image): `har control up` / `har control down`

See [`control/AGENT.md`](./control/AGENT.md).

### Sample fixtures

| Fixture | Stack | Notes |
|---------|-------|-------|
| `tests/fixtures/go-gin-pg/` | Go + Gin + PostgreSQL | Clean — no `.har/` yet |
| `tests/fixtures/python-fastapi-pg/` | Python + FastAPI + PostgreSQL | Clean |
| `tests/fixtures/node-react-pg/` | Node + Express + PostgreSQL | May already have `.har/` — use `--force` or another fixture |

```bash
cp -r tests/fixtures/go-gin-pg /tmp/har-test
cd /tmp/har-test
har env init
```

### After init — run the harness

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
har env status
```

Shell fallback: `./.har/setup-infra.sh`, `./.har/launch.sh 1`, `./.har/verify.sh 1`, `./.har/teardown.sh 1`.

## Upgrading HAR

When a new `@osfactory/har` release changes harness templates or run storage:

```bash
npm install -g @osfactory/har@latest    # updates CLI/MCP/run storage — does not touch project .har/
har env maintain                  # validation + drift report + adaptation prompt
# apply updates with your coding agent (paste .har/ADAPT-PROMPT.md) or: har env maintain --auto
har env verify 1 --full
```

| Command | Effect | Risk |
|---------|--------|------|
| `npm install -g @osfactory/har@latest` | New run layout, MCP, core behavior | Safe for `.har/` |
| `har env maintain` | Drift report vs bundled templates | Safe — in-place |
| `har env init --force` | Replaces entire `.har/` | **Destructive** — loses customizations |

Do not use `har env init --force` on an adapted project harness.

## Project layout

```
src/
├── index.ts                 # Entry point
├── cli/
│   ├── index.ts             # yargs setup
│   └── commands/            # env, agents, control, hooks, mcp, preferences, telemetry
├── core/
│   ├── harness.ts           # init, maintain, describe
│   ├── run-service.ts       # Public execution API (CLI/MCP import this)
│   ├── local-executor.ts    # Local bash/script stage runner
│   ├── slot-registry.ts     # .har/slots/agent-<id>.json
│   ├── validations.ts       # Tree-hash validation records
│   ├── hooks.ts             # Commit gate install / check
│   ├── runs.ts              # Local run history (.har/runs/)
│   └── types.ts             # ExecutionContext, StageExecutor, shared types
├── harness/
│   ├── generator.ts         # Copy boilerplate into .har/
│   ├── stages.ts            # stages.json registry I/O
│   ├── schema.ts            # Re-exports packages/schemas
│   ├── plugins.ts           # har env add-plugin playwright|rocketsim
│   └── …
├── mcp/                     # MCP stdio adapter
├── llm/                     # Optional --auto authoring agent
├── templates/               # Files copied into target .har/ on init
└── utils/                   # File ops, shell, logging, validation

packages/schemas/            # Canonical Zod schemas (@har/schemas)
control/                     # Mission Control (Next.js) + control/.har/
docs/                        # Astro/Starlight site (harproject.dev)
tests/                       # Jest tests + fixtures/
release/                     # semantic-release helpers
.har/                        # Dogfood harness for the CLI
```

## Where to put changes

| Change | Location |
|--------|----------|
| Schema, stage kinds, result shapes | `packages/schemas/src/schema.ts` (+ `src/harness/schema.ts` re-export) |
| Manifest / stages.json I/O | `src/harness/manifest.ts`, `stages.ts` |
| Scaffold copy, boilerplate wiring | `src/harness/generator.ts` |
| Init / maintain / describe orchestration | `src/core/harness.ts` |
| Run orchestration (launch, verify, teardown) | `src/core/run-service.ts` |
| CLI subcommand or flag | `src/cli/commands/<group>.ts` (+ register in `src/cli/index.ts` if new top-level) |
| MCP tool handler or JSON Schema | `src/mcp/server.ts`, `schemas.ts` |
| Files copied into target `.har/` | `src/templates/har-boilerplate*/` |
| Optional verification plugins | `src/templates/plugins/` (via `har env add-plugin`) |
| Generic shell/path/logging helper | `src/utils/` |

When unsure: put domain logic in `harness/` or `core/`, never in an adapter. See [AGENT.md](./AGENT.md) for anti-patterns and extension points.

## TypeScript conventions

- **Zod at boundaries** — parse CLI/MCP inputs with `.parse()` / `.safeParse()`; infer types with `z.infer`.
- **`strict: true` always** — do not weaken compiler settings in `tsconfig.json`.
- **Prefer `unknown` over `any`** — narrow with Zod or type guards before use.
- **Const arrays for enums** — e.g. `HAR_STAGE_KINDS` drives Zod, MCP JSON Schema, and tests from one source.
- **Core vs adapters** — business logic in `src/core/` and `src/harness/`; `cli/` and `mcp/` handle argument parsing and formatting only.
- **Fixture-first tests** — mock `.har/` scripts under `tests/fixtures/minimal-harness/`; avoid real Docker in unit tests.
- **Run `npm run typecheck`, `npm run lint`, and `npm test`** before opening a PR (or rely on `har env verify 1 --full`).

## Making changes

### Templates (`src/templates/har-boilerplate*/`)

These files are copied verbatim into a target repo's `.har/` on `har env init`. After editing:

1. Run `npm run build`
2. Test with `har env init --force --profile cli` on a fixture (or `--profile default` / `ios`)

Placeholders like `__PROJECT_NAME__` in `harness.env` are substituted during scaffold.

### LLM prompts (`src/llm/prompts/`)

System prompts for the optional `--auto` authoring agent. Rebuild to copy them into `dist/prompts/`. Test with `har env init --auto` (requires API key).

### CLI commands

Add or modify subcommands in the matching file under `src/cli/commands/` (`env.ts`, `agents.ts`, `control.ts`, `hooks.ts`, `mcp.ts`, `preferences.ts`, `telemetry.ts`). Register new top-level commands in `src/cli/index.ts`. Prefer implementing orchestration in `src/core/` and keeping the CLI as a thin adapter.

### Plugins

1. Add a bundle under `src/templates/plugins/<name>/`
2. Register the id in `src/harness/plugins.ts` (`PLUGIN_IDS`)
3. Rebuild and test with `har env add-plugin <name>` on a fixture

### Tests

Jest picks up `tests/**/*.test.ts`. Add unit tests alongside fixtures as the suite grows. Mission Control uses Vitest and Playwright under `control/`.

## Pull requests

Before opening a PR:

```bash
har env verify 1 --full
# or, without the harness:
npm run typecheck && npm run lint && npm test && npm run build
npm run drift --prefix docs   # if you touched CLI/MCP/schemas/templates/docs
```

Describe how you tested (e.g. `har env init` on `go-gin-pg` fixture).

### Commit messages (required for releases)

Releases are cut automatically when PRs merge to `main`. [semantic-release](https://semantic-release.gitbook.io/) reads [Conventional Commits](https://www.conventionalcommits.org/) and bumps semver accordingly:

| Commit prefix | Release |
|---------------|---------|
| `fix:` | Patch |
| `feat:` | Minor |
| `feat!:` or `BREAKING CHANGE:` footer | Major |
| `chore:`, `docs:`, `test:`, `refactor:`, `ci:` | No release |
| `feat(benchmark):`, `*(ci):`, `docs(*):` | No release (type/scope rules in [release.config.cjs](release.config.cjs): types `ci` + `docs`, scopes `ci` + `benchmark`) |

Examples:

```text
feat: add har env runs export command
fix: tolerate missing stages.json on maintain
feat!: drop legacy run JSON layout

BREAKING CHANGE: run records now require runId v2 fields
```

Use scopes when helpful (`feat(cli):`, `fix(control):`). Squash-merge PR titles should follow the same format — they become the commit on `main`.

Maintainer release mechanics (npm, Docker Hub, secrets, version coupling): [RELEASING.md](./RELEASING.md).

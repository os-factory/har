# Contributing to har

Guide for developing the CLI locally and testing it against real (or sample) repositories.

**Coding agents:** read [AGENT.md](./AGENT.md) first for architecture rules, where to put changes, and extension points. This file covers setup, workflow, and PR details.

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

By submitting a pull request or other contribution, you agree to the [Contributor License Agreement](./CLA.md), which grants the maintainer rights needed for dual licensing (public AGPL and separate commercial licenses).

## Prerequisites

- **Node.js ≥ 20**
- **npm**
- **`ANTHROPIC_API_KEY`** — required only for `--auto` on `har env init` / `har env maintain`
- **Docker** — optional; needed when running harness scripts (`setup-infra.sh`, `launch.sh`, etc.) on projects that use containers

## Setup

```bash
git clone https://github.com/antoineFrau/har har-project
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

### Mission Control dashboard

Local observability UI (Next.js + shadcn/ui + Postgres):

```bash
har control up          # pulls theosfactory/har-control:<cli-version> from Docker Hub
har control up --build  # build locally from source (monorepo contributors)
# open http://localhost:3847

cd control && npm run dev   # dashboard development without Docker app image
```

**Port 3847** is shared by `har control up` (Docker) and Mission Control harness slot 1 (`cd control && har env launch 1`). Do not run both at once on the default port:

- **Agent dev** (hot reload, worktrees): `cd control && har env launch 1` — preflight auto-picks an alternate port when 3847 is busy and names `har control up` as the cause.
- **Packaged dashboard** (Docker image): `har control up` / `har control down` — warns if harness slot 1 is already active.

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

## Releases

### npm packages

| Package | Published? | Notes |
|---------|------------|-------|
| `@osfactory/har` | **Yes** | Public npm package; global `har` binary |
| `@har/control` | No | `"private": true`; Mission Control source in monorepo |
| `@har/schemas` | No | `"private": true`; consumed via monorepo path in `control/` |

### npm organization (`@osfactory`)

Before the first public release, maintainers must own the **`@osfactory`** scope on npm:

1. Sign in at [npmjs.com](https://www.npmjs.com/) as a project maintainer.
2. Create the **`@osfactory`** organization: [npmjs.com/org/create](https://www.npmjs.com/org/create) (free for public packages).
3. Add other maintainers under **Organization → Members**.
4. Create an **Automation** token with **Publish** access to `@osfactory/har` (and scope-wide publish if you prefer).
5. Add the token as the `NPM_TOKEN` repository secret (see below).

The root `package.json` sets `"publishConfig": { "access": "public" }` so scoped publishes are public by default.

### Initial public version

The first npm release is **`0.1.0`**, matching the current root `package.json`. Tag that baseline on `main` once before enabling automated releases (see below).

### Test a publish tarball locally

`prepublishOnly` runs `npm run build` automatically. To smoke-test the packed artifact before release:

```bash
npm run build
npm pack
npm install -g osfactory-har-*.tgz
har --help
npm uninstall -g @osfactory/har
rm osfactory-har-*.tgz
```

The tarball should contain `dist/` (bundled CLI + templates + prompts), `control/docker-compose*.yml`, plus `package.json`, `README.md`, `LICENSE`, and this changelog — not the Mission Control app source or test fixtures.

Maintainers do **not** hand-cut version tags after the baseline. Merge conventional commits to `main`; the [Release workflow](.github/workflows/release.yml) runs on every push to `main` and, when semantic-release finds releasable commits:

1. Runs full CLI + Mission Control verification
2. Bumps `@osfactory/har`, `@har/control`, and `@har/schemas` to the same version (npm package prepared, **not** published yet)
3. Creates git tag `vX.Y.Z` and a **GitHub Release** (with CLI tarball + compose assets)
4. Pushes **`theosfactory/har-control`** to Docker Hub (`X.Y.Z`, `X.Y`, `X`, and `latest`)
5. Publishes `@osfactory/har` to **npm** only after the Docker push succeeds

If there is nothing to release, verify still runs and publish steps are skipped. If Docker publish fails, npm is **not** published for that tag (fix the image, then use [Publish Docker (manual)](.github/workflows/publish-docker.yml) and publish npm from the tag, or re-run the failed jobs).

### Maintainer setup

Before the first automated release, tag the current baseline on `main` so semantic-release continues from the existing version:

```bash
# one-time, when package.json is already 0.1.0
git tag v0.1.0 && git push origin v0.1.0
```

Repository secrets:

| Secret | Used by |
|--------|---------|
| `NPM_TOKEN` | npm publish for `@osfactory/har` (Automation token with publish access to the `@osfactory` scope) |
| `DOCKERHUB_TOKEN` | Docker Hub publish for `theosfactory/har-control` (PAT with read/write on the repo) |
| `GITHUB_TOKEN` | GitHub Release (provided by Actions) |

Dry-run the next release from the Actions tab (**Release → Run workflow → Dry run**) or locally:

```bash
npm ci
GITHUB_TOKEN=... NPM_TOKEN=... npx semantic-release --dry-run
```

### Version coupling

`@osfactory/har`, Mission Control (`control/`), and `@har/schemas` share one semver. [semantic-release](release.config.cjs) keeps them aligned:

1. `@semantic-release/npm` bumps root `package.json` with `npmPublish: false` (prepare only)
2. [`release/sync-package-versions.js`](release/sync-package-versions.js) syncs `control/` and `packages/schemas/`
3. `@semantic-release/github` creates git tag `vX.Y.Z` and the GitHub Release
4. The Release workflow `publish-docker` job pushes `theosfactory/har-control:X.Y.Z` (plus `X.Y`, `X`, and **`latest`**)
5. The `publish-npm` job publishes `@osfactory/har@X.Y.Z` to npmjs **after** Docker succeeds
6. Installed CLI reads its own `package.json` version and pulls `theosfactory/har-control:<same-version>` on `har control up`

Override with `HAR_CONTROL_IMAGE` / `HAR_CONTROL_IMAGE_TAG`, or use `har control up --build` / `HAR_CONTROL_BUILD=true` to build locally from a git checkout.

To publish the Mission Control image manually (maintainers):

```bash
docker login
./release/publish-control-image.sh
```

Releases also publish via the Release workflow automatically. To republish an existing tag manually, use [Publish Docker](.github/workflows/publish-docker.yml) (workflow_dispatch; set **force** to rebuild if the version tag already exists) or `./release/publish-control-image.sh`.

Docker publish builds `linux/amd64` and `linux/arm64` in parallel on native runners (not QEMU), with per-platform GitHub Actions cache. If the exact `theosfactory/har-control:X.Y.Z` tag already exists, the build is skipped unless **force** is set.

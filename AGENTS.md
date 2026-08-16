# HAR — Agent Development Guide

Guide for coding agents working on **this repository** (`@osfactory/har` — the CLI and MCP control plane).

For setup, testing fixtures, and PR workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

This repo **dogfoods HAR** — `.har/` at the repo root defines how coding agents validate changes here.

<!-- har:agent-environment:start -->
## Harnesses in this repo

This is a monorepo with **three harnesses** — pick the one that owns the files you are changing:

| Path | Profile | Runs | Use when changing | Docs |
|------|---------|------|-------------------|------|
| `.har/` | cli | `@osfactory/har` (typecheck, build, unit tests, lint) | `src/`, `packages/`, `tests/` | [.har/README.md](.har/README.md) |
| `control/.har/` | default | Mission Control (Next.js + SQLite, browser-e2e) | `control/` | [control/.har/README.md](control/.har/README.md) |
| `docs/.har/` | default | Docs / marketing site (Astro + Playwright screenshots) | `docs/` | [docs/.har/README.md](docs/.har/README.md) |

Run harness commands from the directory that owns the harness (e.g. `cd docs && har env launch 1`). See [control/AGENTS.md](control/AGENTS.md) and [docs/AGENTS.md](docs/AGENTS.md) for project guides.

**The harness is how you run each project** — to see Mission Control or the docs site live (manual testing, browser, screenshots), launch the matching slot; never hand-roll docker/dev-server startup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

Docs UI work: use `docs/.har/` so full verify produces before/after screenshots under `docs/.har/artifacts/browser-e2e/screenshots/`. The root CLI harness may still run docs contract checks (`drift` / build) when changing product surfaces that the docs describe — that does not replace launching the docs harness for landing-page or Starlight UI changes.

## Harness workflow (dogfooding)

Follow [`.cursor/rules/har-workflow.mdc`](.cursor/rules/har-workflow.mdc) and
[`.har/README.md`](.har/README.md): launch first, edit only under the session work
dir, full-verify before done, then present a session handoff and wait for approval.
When the task names a tracker issue or ticket, bind at launch with a short
`--work-id`, plus `--work-source`, `--work-url`, and `--work-title` when known.
Default recommendation is complete + open a PR when tooling is available (still
requires approval); never run `complete`, push, or PR autonomously.

Configure Cursor MCP from [`.cursor/mcp.json.example`](.cursor/mcp.json.example)
(see [CONTRIBUTING.md](./CONTRIBUTING.md)). Prefer MCP or `har env …` over
`./.har/*.sh` so run history is persisted. Use
`har env launch 1 --no-worktree` only when you must use the repo root checkout.

## Run history

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | No — same behavior, no run record |
| `har env launch/verify/...` | Yes |
| MCP `har_run_*` | Yes |

Run records are stored under the **main checkout** `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (local date/time). With worktree slots, tests run in the worktree but run JSON stays in the main repo; each record includes a `workDir` field.

Use MCP or `har env verify` by default — they persist run history. Use `./.har/*.sh` only when the CLI is not installed.

If your IDE workspace is a worktree, pass `--repo /path/to/main/checkout` to `har env` commands (MCP config already points at the main checkout).

## Upgrading HAR

```bash
npm install -g @osfactory/har@latest    # updates CLI/MCP/run storage only
har env maintain                  # drift report + adaptation prompt
# apply updates via your coding agent (paste .har/ADAPT-PROMPT.md)
har env verify 1 --full
```

Do not use `har env init --force` on an adapted harness — it wipes customizations. See [CONTRIBUTING.md](./CONTRIBUTING.md#upgrading-har).

### Cursor rule

`har env init` and `har env maintain` optionally scaffold `.cursor/rules/har-workflow.mdc` in the target repo — a Cursor rule that injects the harness read-before-change / verify-before-done workflow into every agent session.

```bash
har env maintain --cursor-rule     # force-write without prompting
har env maintain --no-cursor-rule  # skip Cursor rule scaffolding
```

When the workspace has a `.cursor/` directory and no rule yet, the CLI prompts. In CI or with `--yes`, it writes silently. The rule is refreshed automatically on every `maintain` run when it already exists.

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

`templates/` holds scaffold assets copied into target repos — not runtime logic.

## Dependency rules

These are non-negotiable. Do not introduce imports that violate them.

| Layer | May import | Must not import |
|-------|------------|-----------------|
| `cli/`, `mcp/` | `core/`, `harness/`, `utils/` | each other |
| `core/` | `harness/`, `utils/` | `cli/`, `mcp/` |
| `harness/` | `utils/` | `core/`, `cli/`, `mcp/` |
| `utils/` | other `utils/` | anything with HAR domain concepts |

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
| Optional verification plugins | `src/templates/plugins/` (applied via `har env add-plugin`) |
| Generic shell/path/logging helper | `src/utils/` |

When unsure: put domain logic in `harness/` or `core/`, never in an adapter.

## Public API

Adapters and tests import execution from **`src/core/run-service.ts`** (or the `run.ts` re-export). Do not import `local-executor.ts` from outside `core/`.

Canonical schemas live in **`src/harness/schema.ts`**. Parse CLI and MCP inputs at the boundary with Zod (`.parse()` / `.safeParse()`); infer types with `z.infer`.

Const arrays like `HAR_STAGE_KINDS` are the single source of truth — use them for Zod enums, MCP JSON Schema, and tests.

## Extension points

Design for a closed core with open seams. **Plugins** are first-class installable
bundles under `src/templates/plugins/` (`har env add-plugin`). Bundled plugins are
discovered from disk; out-of-tree installs use path/npm/git specs. A *remote community
plugin marketplace* can wait until there is a concrete external publisher —
naming plugins ≠ shipping a marketplace.

- **`StageExecutor`** (`src/core/types.ts`) — swap local vs cloud execution by injecting a different executor into `RunService`. `local-executor.ts` is the current implementation.
- **Project-owned stages** — runtime behavior lives in the target repo's `.har/` scripts and `stages.json`, not as hardcoded tool APIs in core.
- **Plugins** — optional bundles applied with `har env add-plugin <id|path|npm|git>` (e.g. `playwright` → `browser-e2e` stage + test scaffold). Discovered from `src/templates/plugins/*/template.manifest.json` (no closed enum). Installs are recorded in `.har/plugins.json`. They compile down to generic stage kinds (`setup`, `launch`, `verify`, `test`, `custom`, etc.). Do not add stack-specific MCP tools like `run_playwright`. Philosophy: *plugins install stages; agents only talk to the stage registry.*
- **Profiles** — ordered runtime bundles (`src/templates/profiles/<id>/profile.manifest.json`), not forked logic in core. Stack capabilities (PM2, Simulator, ports) are detected via `src/harness/capabilities.ts` marker files.

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

## Branch names, CI, and releases

Git **branch names do not skip CI or releases**. Name the base branch for clarity, then match the **commit / squash-merge title** to [CONTRIBUTING.md](./CONTRIBUTING.md#commit-messages-required-for-releases) (that title becomes the commit on `main`).

### Recommended base-branch prefixes

| Work | Base branch | Commit / PR title |
|------|-------------|-------------------|
| Docs site or markdown only (`docs/**`, `*.md`) | `docs/<short-topic>` | `docs: …` |
| CI / workflows only | `ci/<short-topic>` | `ci: …` |
| Benchmarks only | `benchmark/<short-topic>` | any type with `(benchmark)` scope, e.g. `chore(benchmark): …` |
| Product changes | `feat/…`, `fix/…`, etc. | `feat:` / `fix:` (these **do** release) |

HAR session branches are derived from whatever base you launch from (`docs-…-har-agent-…`). Prefer starting from a `docs/…` or `ci/…` base when the change is non-releasing.

### What actually avoids a release

[semantic-release](./release.config.cjs) cuts a version from Conventional Commits on `main`. Matching [CONTRIBUTING.md](./CONTRIBUTING.md#commit-messages-required-for-releases):

| Commit prefix | Release |
|---------------|---------|
| `fix:` | Patch |
| `feat:` | Minor |
| `feat!:` or `BREAKING CHANGE:` footer | Major |
| `chore:`, `docs:`, `test:`, `refactor:`, `ci:` | No release |
| `feat(benchmark):`, `*(ci):`, `docs(*):` | No release ([release.config.cjs](./release.config.cjs) rules) |

Explicit analyzer rules in [release.config.cjs](./release.config.cjs): type `ci`, type `docs`, scope `ci`, and scope `benchmark` all set `release: false`. Prefer type `ci:` / `docs:` for those-only PRs — not `feat(docs):` or `fix(docs):` (type `feat`/`fix` still releases unless the scope is `ci` or `benchmark`). Squash-merge PR titles must follow the same format.

### What actually skips CI jobs

| Workflow | When it runs | How to skip / limit |
|----------|--------------|---------------------|
| [Test](.github/workflows/test.yml) | Every PR → `main` | Not skipped by branch name or `docs:` / `ci:` commits today |
| [Release](.github/workflows/release.yml) | Push to `main` | Add `[skip ci]` to the merge commit message to skip verify + release jobs |
| [Docs](.github/workflows/docs.yml) | Push/PR touching `docs/**` (and related paths) | Path-filtered — only runs when those paths change |

For docs-only updates: branch `docs/<topic>`, title `docs: …`. For CI-only updates: branch `ci/<topic>`, title `ci: …`. To also skip the Release workflow after merge, add `[skip ci]` to the squash message (e.g. `docs: refresh landing copy [skip ci]`). The Docs workflow may still run when `docs/**` changes — that is intentional.

## Before finishing

```bash
har env launch 1                # if not already launched this session
har env verify 1                # typecheck + unit tests
har env verify 1 --full         # + lint + build — required before declaring done
# then: session handoff → wait for user → on approval of default (complete + PR):
# push + open PR, then:
har env complete 1              # full verify + validation + teardown; branch kept
```

Or use MCP `har_run_verification` / `har_complete_environment` (preferred in Cursor). Shell fallback: `./.har/verify.sh 1 --full` then `./.har/teardown.sh 1` (no validation record — prefer CLI/MCP `complete` when available).

Do not end the session without a handoff prompt. Never autonomously run `complete`, push, or open a PR. The default handoff recommendation is complete + PR when tooling is available.

If you changed `src/templates/`: `npm run build`, then `har env init --force --profile cli` on a fixture (or `--profile default` for web apps).

<!-- har:agent-environment:end -->

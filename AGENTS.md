# HAR — Agent Development Guide

Guide for coding agents working on **this repository** (`@osfactory/har` — the CLI and MCP control plane).

For setup, testing fixtures, and PR workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

This repo **dogfoods HAR** — `.har/` at the repo root defines how coding agents validate changes here.

<!-- har:agent-environment:start -->
## HAR / agent environment

The harness is not just a verification gate — it is **how you run this project**.
To see the app live (manual testing, browser sessions, screenshots, driving the UI),
use `har env launch <id>` or `./.har/launch.sh <id>`. It already encodes database
setup, ports, env vars, and process management — never hand-roll `docker` / dev-server
startup, and never claim a task "can't be verified live" without launching a slot first.

If a harness command fails, fix the harness (or report the failure) — do not quietly
fall back to ad-hoc commands.

### Before making changes

1. On the **main checkout**, switch to the intended base (usually `main`) — launch
   creates a worktree from that HEAD.
2. **Launch first** — MCP `har_launch_environment` / `har env launch 1`. Use the
   returned **work dir** for ALL edits (never the main checkout).
   **Bind tracker work** when the task names a durable issue or ticket (GitHub,
   Linear, etc.): pass a short repo-scoped `--work-id` / `workUnitId` (e.g.
   `widget-123`), `--work-source` / `source`, `--work-url` / `sourceUrl`, and
   `--work-title` / `title` when known. Skip binding for ad-hoc work with no
   tracker identity.
3. Read [`.har/README.md`](.har/README.md), [`.har/stages.json`](.har/stages.json), then
   [`.har/CLAUDE.agent.md`](.har/CLAUDE.agent.md) (slot URLs / definition of done).
4. Hot-reload usually applies; if not, `./.har/agent-cli.sh <id> restart` (no-op on
   cli/ios profiles without managed processes).

**Occupied slots always block.** Run `complete` / `teardown`, then `launch`. Resume
failed/starting launches with `--resume` / `recover`. Prefer a free slot (2+) over
sharing slot 1 across unrelated chats. Check `har_get_status` / `har env status` first.
Commit early — teardown keeps the branch, not uncommitted work.

### After making changes

Prefer MCP → CLI → shell. Quick verify for the loop; **full verify before done**.

- MCP: `har_run_verification` / `full: true`; finish with `har_complete_environment`
  (propose; wait for approval) or `har_teardown_environment`
- CLI: `har env verify 1`, `har env verify 1 --full`, `complete 1`, `teardown 1`
- Shell: `./.har/verify.sh 1`, `./.har/verify.sh 1 --full`, `./.har/teardown.sh 1`

Commit in the session worktree. Run JSON stays in the main checkout `.har/runs/`.

### Definition of done

- Full verify passes; edits only in the session worktree; tests cover new behavior;
  changes committed; show preview URLs; then **session handoff** (below).

### Session handoff (required)

After full verify and commit, stop. Include summary, session branch
(`.har/slots/agent-<id>.json`), and preview URLs. Wait — never autonomously
complete, teardown, push, or open a PR. **Default:** when `gh`/GitHub MCP is available,
recommend **Complete + open a PR** (still needs approval). Alternatives: **Complete only**,
or **Something else**. Without PR tooling, recommend **Complete only** and give the
session branch for a manual push.

### Commit gate

Full verify records a tree hash under `.har/validations/`. With `har hooks install`,
commits must match a passing full verify. Re-verify after any edit; `git add -A`.
Do not bypass (`--no-verify`, `HAR_SKIP_GATE=1`).

### Cursor IDE

If `.cursor/rules/har-workflow.mdc` exists, the same harness workflow is injected into
every Cursor agent session automatically. Run `har env init` or `har env maintain` to
create or refresh it.
<!-- har:agent-environment:end -->

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
Add secondary links (GitHub issue, PR, Bitbucket) with repeatable
`--work-link source|url|label` at launch, or later via
`har env work-link --work-id <id> --link …` / MCP `har_add_work_unit_link`. Bind the
planning tracker (Jira/Linear) as `--work-url`; attach code-host links as related
links. Include any remaining links in session handoff until attached.
Default recommendation is complete + open a PR when tooling is available (still
requires approval); never run `complete`, push, or PR autonomously.

Configure Cursor MCP from [`.cursor/mcp.json.example`](.cursor/mcp.json.example)
(see [CONTRIBUTING.md](./CONTRIBUTING.md)). All three surfaces are equivalent in
1.0 — prefer MCP or `har env …` for the richer structured output, not because
the shims lose anything. Use `har env launch 1 --no-worktree` only when you must
use the repo root checkout.

## Run history

Since 1.0 the `./.har/*.sh` scripts are thin shims over the packaged runtime, so
**every entry point executes the same code and writes the same records**:

| Entry point | Writes `.har/runs/`? |
|-------------|------------------------|
| `./.har/*.sh` | Yes — shims delegate to `har env …` |
| `har env launch/verify/...` | Yes |
| MCP `har_run_*` | Yes |

Run records are stored under the **main checkout** `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` (local date/time). With worktree slots, tests run in the worktree but run JSON stays in the main repo; each record includes a `workDir` field.

The commit gate is therefore satisfiable from any surface. Prefer MCP or
`har env …` for structured output and tracker binding — not because the shims
record less.

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

## Operation × surface matrix (CLI ↔ MCP)

Every environment operation is available on both surfaces unless listed here as an
intentional hole. Both surfaces delegate to the same `core/run-service.ts` /
`core/harness.ts` code paths; status is one structured implementation
(`collectEnvironmentStatus`) with text rendered on top, the launch guard runs
exactly once inside `run-service`, and status is a pure read (no run records) on
every surface.

| Operation | CLI | MCP |
|---|---|---|
| describe / init / maintain / add-plugin | `har env init`, `maintain`, `add-plugin` | `har_describe_project`, `har_init_harness`, `har_maintain`, `har_add_plugin` |
| launch / recover / preflight | `har env launch`, `recover`, `preflight` | `har_launch_environment`, `har_recover_environment`, `har_preflight_environment` |
| verify / run-stage / logs / status / artifacts | `har env verify`, `run-stage`, `logs`, `status`, `artifacts` | `har_run_verification`, `har_run_stage`, `har_get_logs`, `har_get_status`, `har_list_artifacts` |
| doctor | `har env doctor` (also auto-runs in `maintain` and before `launch`) | `har_doctor` |
| complete / teardown | `har env complete`, `teardown` | `har_complete_environment`, `har_teardown_environment` |
| runs / work links | `har env runs list\|get`, `work-link` | `har_list_runs`, `har_get_run`, `har_add_work_unit_link` |
| Mission Control | `har control up` | `har_control_up` |

Intentional holes (human-only, no MCP tool):

- `har env cleanup` — cross-repo destructive teardown with interactive confirmation; an
  agent must free its own slot with complete/teardown instead.
- `har env add-stage --custom` — authoring a project stage is an adaptation task done in
  the checkout, not a tool call; agents edit `.har/stages.json` + `stages/` directly.
- `har env eject` / `har env adopt` — taking (or returning) ownership of the runtime
  scripts is a deliberate human policy decision with an interactive confirmation.
- Hooks / commit-gate onboarding (`har hooks …`, init/maintain onboarding prompts) —
  installs git hooks and records user policy preferences; a policy decision for humans.
- Onboarding/preferences, telemetry toggles, and portal login (`har onboard`,
  `har preferences`, `har telemetry`, `har hq`) — account- and machine-level state.

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
har env verify 1                # typecheck + build + docs check/build
har env verify 1 --full         # + unit tests, lint, docs-drift — required before declaring done
# then: session handoff → wait for user → on approval of default (complete + PR):
# push + open PR, then:
har env complete 1              # full verify + validation + teardown; branch kept
```

Or use MCP `har_run_verification` / `har_complete_environment` (preferred in Cursor). Shell equivalent: `./.har/verify.sh 1 --full` then `./.har/teardown.sh 1` — the shims write the same validation records, but `complete` (CLI/MCP) is still preferred over bare `teardown` because it closes the work attempt.

Do not end the session without a handoff prompt. Never autonomously run `complete`, push, or open a PR. The default handoff recommendation is complete + PR when tooling is available.

If you changed `src/templates/`: `npm run build`, then `har env init --force --profile cli` on a fixture (or `--profile default` for web apps).

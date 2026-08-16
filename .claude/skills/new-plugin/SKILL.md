---
name: new-plugin
description: Factory line for adding a new HAR verification plugin (like playwright or rocketsim) for any framework — research the framework docs, build the template under src/templates/plugins/, register it everywhere, validate on a real repository, and open a PR. Use when asked to add/create a plugin, plugin template, or framework integration (e.g. "add a Cypress plugin", "support Maestro", "new plugin for vitest browser mode").
---

# New HAR plugin factory line

Ship a new verification plugin `<id>` for framework `<framework>` end-to-end:
research → template → registration → local validation → real-repo validation → PR.

A plugin is an installable bundle under `src/templates/plugins/<id>/` applied by
`har env add-plugin <id>`. It registers **generic stage kinds** (`test`, `verify`,
`custom`, …) in the target repo's `.har/stages.json`. Philosophy (AGENTS.md):
*plugins install stages; agents only talk to the stage registry.* Never add
stack-specific MCP tools or core stages.

Reference implementations: `src/templates/plugins/playwright/` (web e2e, package.json
merge, CI workflow) and `src/templates/plugins/rocketsim/` (external-tool flows,
no package merge). Pick whichever is closer to `<framework>` as your baseline.

## Phase 0 — Inputs

Establish before doing anything (ask the user only if not inferable):

- **Plugin id** — short lowercase slug (`cypress`, `maestro`, `k6`).
- **Framework** — what it tests and on which stack (web, iOS, API, load…).
- **Stage id** — what the stage does, not the brand (`browser-e2e`, `mobile-flows`,
  `load-test`). Brand goes in the description and docs filename.
- **Validation repo** — a real repository that uses `<framework>` to prove the plugin
  works (Phase 5). An existing example/OSS repo, or a minimal app you scaffold.

## Phase 1 — Research the framework

Do this **before** writing any template file. Use WebSearch/WebFetch on the
framework's official docs and answer:

1. **Headless CLI invocation** — exact command to run tests non-interactively in CI
   (e.g. `npx cypress run`, `maestro test flows/`). Flags for reporter/output dir.
2. **Config file** — name, format, and the minimal config needed; how to inject
   `BASE_URL`/ports via env vars (HAR slots compute ports per agent id).
3. **Artifacts** — where reports/screenshots/videos land and how to redirect them
   into `.har/artifacts/<stage-id>/`.
4. **Install** — npm devDependencies (+ current stable version) or external binary
   (then document a doctor/preflight check instead of a package merge).
5. **CI recipe** — official GitHub Actions setup, for the optional workflow file.
6. **Exit codes** — how failure is signaled so the stage script can pass it through.

Also read both existing plugins in full (`template.manifest.json`, stage script,
stage `.md` doc, README) — copy their structure, don't reinvent.

## Phase 2 — Launch a HAR session

This repo dogfoods HAR. Follow `.har/README.md`: launch first, edit only under the
session work dir, verify before done.

```bash
har env launch 1        # profile cli (.har/ at repo root owns src/, tests/, docs/)
```

Bind `--work-id/--work-source/--work-url/--work-title` if the task names a ticket.

## Phase 3 — Build the template

Create `src/templates/plugins/<id>/` containing:

### 3a. `template.manifest.json` (required — validated by `PluginManifestSchema` in `src/harness/plugins.ts`)

Fields: `id`, `stageId`, `verificationStages` (existing stage ids + the new one —
copy the profile's defaults, e.g. `typecheck`/`unit-tests`/`lint` + `<stage-id>`),
`stage` (a full `HarnessStageSchema` object: `id`, `kind` (usually `"test"`),
`description`, `script: "stages/<stage-id>.sh"`, `requiresAgentId: true`,
`artifacts`), `files` (src→dest copies; stage script gets `"executable": true`),
optional `optionalFiles` (CI workflow with `"skipFlag": "skipCi"`), optional
`merge: { "package.json": "package.fragment.json" }`, `nextSteps` (install →
launch → run stage → view artifacts), and `docsPath` (`.har/stages/<STAGE>.md`).

### 3b. `.har/stages/<stage-id>.sh` (required)

Model it on `playwright/.har/stages/browser-e2e.sh`. Hard conventions (unit-tested):

- `#!/usr/bin/env bash` + `set -euo pipefail`; JSON result to stdout, progress to stderr.
- Take `<agent-id>` as `$1`, `validate_agent_id`, source `harness.env` +
  `agent-slot.sh`, resolve `.env.agent.<id>` and the agent work dir.
- Derive ports from `HARNESS_*_BASE_PORT + AGENT_ID * 10`; export the framework's
  base-URL env vars from them.
- Write all artifacts under `.har/artifacts/<stage-id>/` (main repo root, not worktree).
- **Timing: use `$(now_ms)`; never `date +%s%3N`** (GNU-only).
- **No `mapfile`/`readarray`** (absent in macOS bash 3.2); use `while read` loops.
- Capture the framework's exit code with `set +e … set -e` and propagate it.

### 3c. Docs + scaffold

- `.har/stages/<STAGE>.md` — agent-facing authoring/adaptation guide (what to adapt
  per repo, env vars, artifact layout). This is `docsPath`.
- Minimal working example tests/flows/config the framework actually runs
  (playwright ships smoke specs; rocketsim ships `flows/example-smoke.sh`).
- `README.md` for humans.
- If npm-based: `package.fragment.json` with `scripts` + pinned `devDependencies`.
- Optional `.github/workflows/<id>.yml` from the official CI recipe.

## Phase 4 — Register everywhere (checklist)

| Where | What |
|---|---|
| `src/templates/plugins/<id>/` | Bundle with valid `template.manifest.json` — **discovered automatically** after `npm run build` (no `PLUGIN_IDS` edit) |
| `tests/plugins.test.ts` | Add an `applies <id> plugin to a scaffolded harness` case (mirror the rocketsim one: files exist, executable bit, stage registered, verificationStages, `.har/plugins.json` ledger) |
| `tests/onboarding.test.ts` | Extend the `ids` expectation to contain `<id>` |
| `tests/verify-shell-timing.test.ts` | Add the stage script path to `verifyPaths` (and a `mapfile` check if it does list processing) |
| `docs/src/content/docs/docs/guides/plugins.md` | New section: install command, what it adds, adaptation notes |
| `docs/src/content/docs/docs/reference/cli.md` | Extend `--plugins` / `add-plugin` examples |
| `docs/src/pages/index.astro` + `docs/public/assets/logo-<id>.(svg\|png)` | Landing card with framework logo (fetch an official logo asset) |
| `docs/src/data/plugins.ts` | Marketplace catalog entry |
| `src/harness/adaptation-prompt.ts` | Mention the plugin if it's the natural fit for a profile (like rocketsim ↔ ios) |
| `src/templates/har-boilerplate*/STAGES.md` | Mention in the plugins list where the existing ones are mentioned |

## Phase 5 — Validate locally, then on a real repository

**Local (fixture):**

```bash
npm run build   # templates are copied to dist/ — required before add-plugin sees it
har env verify 1                              # typecheck + unit tests
mkdir -p <scratchpad>/fixture && cd <scratchpad>/fixture
git init -q && npm init -y                    # if the plugin merges package.json
node <repo>/dist/index.js env init --profile default --yes
node <repo>/dist/index.js env add-plugin <id>
cat .har/stages.json                          # stage + verificationStages present
bash -n .har/stages/<stage-id>.sh             # syntax check
```

**Real repo (required — the plugin must be proven to work):**

1. Clone/scaffold the validation repo from Phase 0 into the scratchpad — a repo
   that genuinely uses `<framework>` (e.g. the framework's official example app).
2. `har env init` there (pick the right profile), then `har env add-plugin <id>`.
3. Follow the manifest's own `nextSteps` verbatim: install deps, `./.har/launch.sh 1`,
   run `./.har/stages/<stage-id>.sh 1`.
4. The stage must **pass** and populate `.har/artifacts/<stage-id>/`. If external
   hardware/tooling is unavailable (e.g. iOS simulator on Linux), validate as far as
   the environment allows and state exactly what was and wasn't executed — never
   claim it works untested.
5. Fold every adaptation you needed back into the template or the `<STAGE>.md`
   adaptation guide, rebuild, and re-run until `nextSteps` succeed as written.

## Phase 6 — Verify and hand off

```bash
har env verify 1 --full     # typecheck + unit tests + lint + build — required
```

Then present a session handoff (per `.har/README.md`) and **wait for approval** —
never run `complete`, push, or open a PR autonomously. On approval:

- Branch `feat/plugin-<id>`, commit/PR title `feat: add <framework> plugin` (this
  releases a minor — intended for a new plugin).
- PR body: what the plugin installs, the registration checklist, and **validation
  evidence** — the real repo used, the stage run output/artifacts, and anything
  not executable in this environment.
- `har env complete 1` after the PR is up.

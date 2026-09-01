---
title: Plugins
description: Install framework-specific verification bundles that register stages in your harness — shipped with HAR or from path, npm, or git.
---

## Plugins vs stages vs profiles

| Concept | What it is | Command |
|---|---|---|
| **Profile** | Ordered runtime bundles composing a stack scaffold (`default`, `cli`, `ios`) | `har onboard --profile …` |
| **Stage** | Runtime operation in `.har/stages.json` | `har_run_stage`, `har env verify` |
| **Plugin** | Installable bundle that *registers* one or more stages **and adds them to `verificationStages`** | `har env add-plugin …` |
| **Factory line** | Installable *program* — stations plus a cumulative gate. Registers stages but **never** joins `verificationStages` | `har line add …` |

Profiles are defined in `templates/profiles/<id>/profile.manifest.json` as an ordered
list of runtime bundles (shared kernel, PM2, Xcode, profile overlay). Core detects
capabilities from marker files (e.g. `ecosystem.agent.template.cjs` → PM2), not from
the profile name. See [Profiles](/docs/guides/profiles/).

Plugins compile down to generic stage kinds. Agents interact with the stage
registry — never with stack-specific MCP tools like `run_playwright`.

Profiles and plugins share one ledger file (`.har/plugins.json`): init records
`profile` + `bundles`; each `add-plugin` appends to `plugins[]`. They are still
different layers — profiles scaffold the environment; plugins add verification stages.
Factory lines keep their own ledger (`.har/lines.json`) for the same reason they
have their own command: installing one must not widen verification.

**Which one do I want?** Ask whether the check should run on every
`har env verify --full`. Yes → a plugin (this guide). No, it gates a *station*
of a program → a [factory line](/docs/guides/factory-lines/), installed with
`har line add`. Programs install with `har line add`, not `add-plugin` —
`add-plugin` refuses a line bundle and points you at the right command.

## Discovery and install

```bash
har env add-plugin --list
```

Bundled plugins are **discovered from disk**: every directory under the CLI’s
`templates/plugins/` that contains a valid `template.manifest.json` appears in
`--list`. There is no hardcoded allowlist in core — shipping a new plugin in a HAR
release is add-the-folder and publish.

You can also install from outside the CLI package:

```bash
har env add-plugin playwright                    # bundled id
har env add-plugin ./my-har-plugin               # local path
har env add-plugin @myorg/har-cypress            # npm package
har env add-plugin github:myorg/har-plugin-cypress  # git
```

Resolution order: path → git → bundled id → npm. The target must expose
`template.manifest.json`. Installs are recorded in `.har/plugins.json` (source,
stage ids, timestamp). `har env maintain` uses the ledger when present, otherwise
falls back to matching stage ids in `stages.json`.

Every successful install also writes `.har/ADAPT-PROMPT-<id>.md` — a structured
adaptation prompt for your coding agent (install dependencies with the repo's
real package manager, adapt the scaffolded files, prove the stage green via full
verify) — and offers to copy it to the clipboard, like `har onboard` does.
A `package.json` merge declares dependencies but does **not** install them; the
prompt leads with the install command.

## Multi-stage plugins

A plugin manifest may declare `stages: [...]` (preferred) or the legacy single
`stage` + `stageId` pair. All registered stage ids are written to the ledger.

## Playwright

```bash
har env add-plugin playwright
```

This adds:

- a `browser-e2e` test stage;
- Playwright configuration;
- frontend, API health, and accessibility smoke specs;
- artifact directories, plus a CI workflow when `--with-ci` is passed (CI files are skipped by default).

Adapt selectors and URLs after installation. Full verification runs the stage when
it is listed in `verificationStages` (the plugin updates that list for you).

## Upgrading installed plugins

`har env maintain` compares **installed plugins** (from `.har/plugins.json` when
present, otherwise registered stage ids in `stages.json`) against the bundled
plugin templates shipped with your HAR version.

When plugin files drift:

1. Run `har env maintain`
2. Review `.har/maintain/plugins/<plugin-id>/` (templates, installed copies, diffs)
3. Merge the diffs into your repo **or** refresh everything with:

```bash
har env add-plugin playwright --force
```

Use `--force` only when you are OK overwriting plugin-owned paths listed in the
plugin manifest (config, stage scripts, scaffold specs, merged `package.json` keys).

## RocketSim

```bash
har env add-plugin rocketsim
```

This installs a `rocketsim-flows` runner, authoring guidance, and an example iOS
flow. RocketSim itself and a booted simulator are external requirements.

## Kerno

```bash
har env add-plugin kerno
```

This adds a `backend-validation` test stage that re-runs your committed
[Kerno](https://kerno.io) scenario suite (`.kerno/scenarios/`) against the app
running in a slot, deterministically and with no LLM in the loop. It uses the slot's
own database for greybox checks and reports a pass/fail with a full evidence trail.

Prerequisites: the Kerno CLI (`npm install -g @kerno/cli`), Docker, a Kerno agent
bound to the slot's worktree (`kerno init`), and a committed suite (validate re-runs
an existing suite, it does not generate one).

Kerno runs one agent per machine, so this stage never starts or rebinds the agent and
serializes across slots with a fail-fast lock. Backend validation runs one slot at a
time while frontend stages still run concurrently. See `.har/stages/KERNO.md` for the
full setup and adaptation guide.

## Gitleaks

```bash
har env add-plugin gitleaks
```

This adds:

- a `secrets-scan` test stage that runs [Gitleaks](https://github.com/gitleaks/gitleaks)
  against the agent work dir (uncommitted changes included) and fails on findings;
- a root `.gitleaks.toml` extending the default ruleset with harness allowlists
  (skipped if the repo already has one);
- a CI workflow using the official `gitleaks/gitleaks-action` when `--with-ci`
  is passed (skipped by default).

The `gitleaks` binary is an external requirement (`brew install gitleaks` or a
[release binary](https://github.com/gitleaks/gitleaks/releases)) — the stage
fails fast with an install hint when it is missing. Reports land in
`.har/artifacts/secrets-scan/` with secret values redacted. Pass `git` as the
second stage argument to scan full history instead of the working tree.

The local stage keeps secrets from ever reaching your default branch; the CI
workflow is what produces org-level scanning evidence that compliance platforms
(Vanta, Drata, …) ingest via GitHub. See `.har/stages/GITLEAKS.md` after install
for allowlist and baseline tuning.

## Trivy

```bash
har env add-plugin trivy
```

This adds:

- a `vuln-scan` test stage — [Trivy](https://trivy.dev) scans the agent's
  worktree for known CVEs in dependency lockfiles and misconfigurations in
  Terraform, Dockerfiles, Kubernetes manifests, and other IaC (Trivy absorbed
  tfsec, so Terraform checks are included);
- a `.trivyignore` scaffold for documented suppressions;
- a CI workflow that uploads SARIF to GitHub code scanning when `--with-ci`
  is passed (skipped by default).

The `trivy` binary is an external requirement (`brew install trivy`); the stage
fails fast with an install hint when missing. The fail threshold defaults to
`HIGH,CRITICAL` — tune `HARNESS_TRIVY_SEVERITY` and `HARNESS_TRIVY_SCANNERS` in
`.har/harness.env`, and see `.har/stages/TRIVY.md` for adaptations (container
images, monorepo scoping).

The local stage is pre-merge shift-left; the CI workflow feeds GitHub code
scanning, the org-level evidence layer that compliance platforms such as Vanta
ingest. Keep both.

## Semgrep

```bash
har env add-plugin semgrep
```

This adds:

- a `sast` test stage that scans the session worktree with Semgrep;
- an adaptation guide (`.har/stages/SEMGREP.md`) covering rulesets and noise tuning;
- a CI workflow running the official `semgrep ci` recipe when `--with-ci` is passed (skipped by default).

The `semgrep` CLI itself is an external requirement (`pipx install semgrep`).
Reports (JSON + SARIF) land under `.har/artifacts/sast/`. Pin rulesets with
`HARNESS_SEMGREP_CONFIG` in `.har/harness.env` (default `auto`).

The local stage is the shift-left layer — findings block agents before merge.
For compliance evidence (e.g. Vanta's native Semgrep integration), set the
`SEMGREP_APP_TOKEN` secret so the CI workflow publishes to the Semgrep AppSec
Platform. Local runs are invisible to compliance platforms by design.

## Your own checks

Two paths — pick based on whether the check is project-private or reusable.

### Command stages (not plugins)

Project-specific one-liners (`npm test`, domain scripts) do **not** need a
plugin — register a command stage directly in `.har/stages.json`:

```json
{ "id": "unit-tests-fast", "kind": "test", "command": "npm test", "tier": "quick" }
```

See [Stages and artifacts](/docs/guides/stages/) and `.har/STAGES.md`.

### Local plugins

Anything bigger — a script that needs the slot's env, ports, or artifacts —
is a **local plugin**, project-owned under `.har/plugins/<id>/`:

```bash
har plugin create db-integrity
har env add-plugin db-integrity
```

The scaffold is a complete plugin (manifest, stage script, README, optional
`package.fragment.json`), recorded in `.har/plugins.json` with source `local`.
Publishing it later to npm or git requires zero format changes. Full guide:
[Local plugins](/docs/guides/local-plugins/).

### Publish your own plugin

HAR is open source. Anyone can ship a verification plugin without changing HAR core.

**Start from a local plugin** — `har plugin create <id>` scaffolds the exact
publishable format in `.har/plugins/<id>/`; move it to its own repo or package
when ready.

**Or start from the official boilerplate** (GitHub template + npm package layout):

- Repository: [os-factory/har-plugin](https://github.com/os-factory/har-plugin) (*Use this template*)
- Agent guide (fit + examples): [AGENTS.md](https://github.com/os-factory/har-plugin/blob/main/AGENTS.md)
- Authoring guide: [docs/AUTHORING.md](https://github.com/os-factory/har-plugin/blob/main/docs/AUTHORING.md)
- Try the example: `har env add-plugin github:os-factory/har-plugin`

**1. Author a bundle** — a directory with:

- `template.manifest.json` (required) — `id`, `stages` (or legacy `stage` + `stageId`),
  `verificationStages`, `files`, `nextSteps`, `docsPath`
- Stage script(s) under `.har/stages/`
- Optional: `package.fragment.json`, CI workflow, smoke fixtures, adaptation guide

Rename the example `id` / stage, implement the script, run `npm run check-manifest`.
You can also copy an existing bundled plugin under HAR’s `src/templates/plugins/`
(e.g. Playwright or Gitleaks). Manifests prefer `stages: [...]` for one or more stages.

**2. Distribute**

| Channel | How users install |
|---|---|
| Upstream HAR | PR into `src/templates/plugins/<id>/` — after release it appears in `add-plugin --list` |
| Local path | `har env add-plugin ./path/to/plugin` |
| npm | Publish a package whose root has `template.manifest.json` → `har env add-plugin @org/har-…` |
| Git | `har env add-plugin github:org/har-plugin-…` |

**3. Consumers** still only run stages — `har env verify --full`, MCP `har_run_stage` —
never a stack-specific tool API.

There is no separate remote app-store yet: discovery is **bundled with the CLI** or an
**explicit** path / npm / git spec. The [plugin marketplace](/plugins/) page catalogs
shipped plugins; community packages install the same way once published.

## Deprecated alias

`har env add-stage playwright` (and `rocketsim`) still works for one release as an
alias of `har env add-plugin`, and prints a deprecation warning. Prefer
`add-plugin` for new docs and skills.

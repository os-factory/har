---
title: Plugins
description: Install framework-specific verification bundles that register stages in your harness.
---

## Plugins vs stages vs profiles

| Concept | What it is | Command |
|---|---|---|
| **Profile** | Env scaffold for a stack (`default`, `cli`, `ios`) | `har env init --profile …` |
| **Stage** | Runtime operation in `.har/stages.json` | `har_run_stage`, `har env verify` |
| **Plugin** | Installable bundle that *registers* one or more stages | `har env add-plugin …` |

Plugins compile down to generic stage kinds. Agents interact with the stage
registry — never with stack-specific MCP tools like `run_playwright`.

## List shipped plugins

```bash
har env add-plugin --list
```

## Playwright

```bash
har env add-plugin playwright
```

This adds:

- a `browser-e2e` test stage;
- Playwright configuration;
- frontend, API health, and accessibility smoke specs;
- CI workflow and artifact directories unless `--skip-ci` is used.

Adapt selectors and URLs after installation. Full verification runs the stage when
it is listed in `verificationStages` (the plugin updates that list for you).

## Upgrading installed plugins

`har env maintain` now compares **installed plugins** (detected via registered
stage ids in `stages.json`) against the bundled plugin templates shipped with
your HAR version.

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

## Custom stages (not plugins)

Project-specific checks (`npm test`, domain scripts) are **custom stages**, not
plugins:

```bash
har env add-stage unit-tests-fast --custom --kind test \
  --command "npm test" --verification
```

See [Stages and artifacts](/docs/guides/stages/) and `.har/STAGES.md`.

## Deprecated alias

`har env add-stage playwright` (and `rocketsim`) still works for one release as an
alias of `har env add-plugin`, and prints a deprecation warning. Prefer
`add-plugin` for new docs and skills.

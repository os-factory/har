---
title: Local plugins
description: Project-owned plugins in .har/plugins/ — the home for checks too big for a command stage.
---

A one-liner check belongs in `stages.json` as a command stage. Anything bigger —
a script that needs the slot's env, ports, or artifacts, a check with its own
dependencies, a multi-stage integration — is a **local plugin**: a full plugin
that lives in your repository under `.har/plugins/<id>/`.

```bash
har plugin create db-integrity   # scaffold .har/plugins/db-integrity/
har env add-plugin db-integrity  # install its stages into stages.json
```

## What the scaffold contains

`har plugin create <id>` writes a complete, publishable plugin:

| File | Purpose |
| --- | --- |
| `template.manifest.json` | Manifest: id, stages it installs, install targets, artifacts |
| `stages/<id>.sh` | The stage script — receives the slot env like any registered stage |
| `README.md` | What the check does and how to adapt it |
| `package.fragment.json` | Optional dependencies merged on install |

Installation is recorded in `.har/plugins.json` with `"source": "local"`, so
`har env maintain` and `har env doctor` treat it exactly like an npm or git
plugin. Agents never interact with the plugin itself — only with the stages it
registers.

## Local first, publish later

The scaffold is the exact publishable format. When a local plugin proves
useful beyond one repository, move the directory to its own repo or npm
package and reinstall from there — zero format changes:

```bash
har env add-plugin ./path-or-package   # npm, git, or path source
```

See [Plugins](/docs/guides/plugins/) for the full plugin system, discovery
(`har env add-plugin --list`), and publishing.

## Replacing `add-stage --custom`

Pre-1.0, `har env add-stage <id> --custom` dropped a skeleton stage script into
the harness. That path was removed in 1.0: project-specific checks are either
plain command stages in `stages.json` or local plugins — both in-repo,
reviewable, and tracked, without a third mechanism. The
[migration guide](/docs/guides/migrating-to-1-0/) covers converting existing
custom stages.

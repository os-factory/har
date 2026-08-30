# har-line

A GitHub template for authoring **HAR factory lines**.

A *factory line* is a program: an ordered set of **stations** plus a
**cumulative gate**. It composes what HAR 1.0 already has — work units, slots,
stages, plugins, skills, MCP. It is not a fourth marketplace and not a second
stage runner.

> **A line is not a verification plugin.** Installing a line registers its
> stages but **never** adds them to `verificationStages`. Default
> `har env verify --full` takes exactly as long as it did before. That is the
> entire reason the two bundle kinds are separate.
>
> If your check should gate *every* verify, use
> [os-factory/har-plugin](https://github.com/os-factory/har-plugin) instead.

## Quick start

1. **Use this template** → name your repo (e.g. `onboarding-line`).
2. Rename the example: `line.manifest.json` `id`, `line.json` `id`/`title`, and
   the stage script under `stages/`.
3. Describe your stations in `line.json`.
4. Install it into a product repo:

```bash
har line add github:your-org/onboarding-line
har line status onboarding-line
har line gate S2 --line onboarding-line
```

## Package layout

```text
har-line/
├── line.manifest.json     # kind: line — what `har line add` applies
├── line.json              # the program: stations, gate, handoff
├── stages/
│   └── example-gate.sh    # extra stage — registered, NOT on verify
├── docs/AUTHORING.md      # how to write a line
├── scripts/check-manifest.mjs
└── AGENTS.md              # line vs verification plugin, for coding agents
```

## Install channels

| Spec | Example |
|---|---|
| Local path | `har line add ./har-line` |
| Git | `har line add github:acme/onboarding-line` |
| npm | `har line add @acme/onboarding-line` |

Add a `package.json` (name, version, `files`) only if you want the npm channel —
git and path installs need nothing else.

Resolution order is path → git → bundled id → npm, the same resolver plugins
use. The package root must contain `line.manifest.json`.

`har env add-plugin` **refuses** a line bundle and points at `har line add`.

## The invariant

After `har line add`, `.har/stages.json` `verificationStages` is unchanged —
no new ids, same default verify duration. `scripts/check-manifest.mjs` asserts
the manifest side of that; the CLI asserts the applied side and refuses to
write if the verify plan moved.

## Related

- [os-factory/har](https://github.com/os-factory/har) — the CLI and MCP control plane
- [os-factory/har-plugin](https://github.com/os-factory/har-plugin) — template for **verification plugins** (these *do* join verify)
- [Factory lines guide](https://har.osfactory.dev/docs/guides/factory-lines/)

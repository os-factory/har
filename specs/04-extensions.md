# 04 — Plugins and factory lines

Open seams around a closed core: verification plugins widen the verify plan, factory lines never do.

- **EXT-1** MUST — `har env add-plugin <id|path|npm|git>` installs a plugin bundle that compiles to generic stage kinds, registers its stages, and records the install in `.har/plugins.json`.
- **EXT-2** MUST — Bundled plugins are discovered from `src/templates/plugins/*/template.manifest.json`; there is no closed plugin enum and no stack-specific MCP tool.
- **EXT-3** MUST — `har line add <id|path|npm|git>` installs a factory line through the same resolve channels as plugins, registers its stages, and never adds them to `verificationStages`.
- **EXT-4** MUST — `add-plugin` refuses a bundle of `kind: line`, `line add` refuses a plugin manifest, and `doctor` fails when a line stage reaches the verify plan.
- **EXT-5** MUST — `har line gate <station>` runs the cumulative stage set of that station through the same run service as every other stage (no second stage runner).
- **EXT-6** SHOULD — `har line status` reports stations in order, the cumulative gate and which of its stages are green.
- **EXT-7** MUST — `har plugin create <id>` scaffolds a project-owned plugin under `.har/plugins/` with a schema-valid manifest that installs by bare id with ledger source `local` and is covered by drift; invalid ids, a missing harness and an existing directory without `--force` are rejected.
- **EXT-8** MUST — `har line create` scaffolds a project-owned line that installs unchanged; a line manifest that declares `verificationStages` is rejected.

Adapt the freshly installed `{{PLUGIN_ID}}` plugin so its verification stage(s) run green in this repository.

## Your mission

`har env add-plugin {{PLUGIN_ID}}` scaffolded files and registered stage(s) {{STAGE_IDS}} in `.har/stages.json` — **scaffolding only**. Nothing was installed or adapted to this app yet, and full verify will fail on the new stage(s) until you finish the steps below.

`.har/` is a **configuration surface** — the runtime machinery lives in the HAR
package behind the `./.har/*.sh` shims. Adapt the plugin through its sanctioned
homes only: the scaffolded specs/config files, `harness.env` values, and the
stage entries in `.har/stages.json`. Never edit the shims.

{{PACKAGE_MERGE_NOTE}}

## Plugin setup steps

{{PLUGIN_SETUP_STEPS}}

## Adapt to this repository

1. Read the plugin docs: `{{DOCS_PATH}}`.
2. Open every scaffolded file listed below and adapt it to this app — selectors,
   routes, API paths, project-specific commands. Scaffolds describe a generic
   app; they are wrong until proven right here.

{{FILES_WRITTEN}}

3. Align `harness.env` with the app where the plugin depends on it (for example
   `HARNESS_HEALTH_CHECK_PATH`, ports/preview URL layout). `har env doctor`
   validates the config.

## Prove it green

```bash
har env launch 1
har env verify 1 --full         # must pass INCLUDING {{STAGE_IDS}}
```

Iterate on the scaffolded files until full verify passes. Artifacts land under
`.har/artifacts/` if the stage declares them. Do not remove the stage from
`verificationStages` to get green — adapt it.

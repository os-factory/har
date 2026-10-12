# HAR harness drift check (benchmark, task-blind)

Repository: `{{repo}}` at commit `{{base_commit}}`
Harness root (main checkout, edit here): `{{harness_root}}`
Time budget for this session: about {{timeout_minutes}} minutes.

## Situation

This repository was already adapted for HAR at an **older** commit
(`{{previous_commit}}`). The adapted harness files were copied onto this newer checkout,
and the benchmark runner then ran its readiness gate (`har env doctor`, `har env launch 1`,
`har env verify 1 --full`). The gate failed. Below are the drift report from
`har env maintain` and the gate output.

You are deliberately **not told what a later agent will be asked to do** at this commit.
Bring the harness back to the definition of done with the smallest change that is right
for this commit: usually a changed command, dependency manager, port, env var, service,
or a stage that no longer matches the project's own scripts.

## Definition of done

`har env doctor` passes; `har env launch 1` succeeds and the app is usable in the slot;
`har env verify 1` passes; `har env verify 1 --full` passes with the project's real checks
(unit tests, lint, browser/API e2e where applicable); `.har/README.md` and `AGENTS.md` are
still truthful.

## Rules for this benchmark

- Edit only harness files in the harness root: `.har/**`, `AGENTS.md`, `CLAUDE.md`,
  `.claude/**`, `.gitignore`. Do not change the project's own source, tests, configuration
  or dependency manifests.
- You may run `har env launch 1`, `har env verify 1 [--full]`, `har env status 1`,
  `har env logs 1`, `har env agent 1 …`, `har env teardown 1` to iterate. Only slot 1.
  **Tear slot 1 down before you finish** (`har env teardown 1 --delete-branch`).
- Do not commit. Finish with `har env maintain --finalize --summary "<what changed>"` and a
  short summary of what drifted and what you changed.

## Drift report (`har env maintain`)

```
{{drift_report}}
```

## Gate failure

{{failure_context}}

# HAR harness adaptation (benchmark, task-blind)

Repository: `{{repo}}` at commit `{{base_commit}}`
Harness root (main checkout, edit here): `{{harness_root}}`
Scaffolded profile: `{{har_profile}}` (`har env init --profile {{har_profile}}` has already been run)
Time budget for this session: about {{timeout_minutes}} minutes.

## What this is

You are preparing this repository so that *another* coding agent can later work on it
through HAR. You are deliberately **not told what that agent will be asked to do** —
do not try to guess or look for hints. Make the harness good for this repository in
general: the application must be up and running in a slot, and the verification stages
must be the ones a maintainer of this project would trust.

## Definition of done (the runner checks all of these after you finish)

1. `har env doctor` passes.
2. `har env launch 1` succeeds and the primary application is actually usable in the
   slot (health endpoint, seeded data, credentials — whatever this project needs).
3. `har env verify 1` (quick tier) passes: fast smoke — compile / typecheck / import / health.
4. `har env verify 1 --full` passes and runs the project's real checks: unit tests, lint,
   and browser or API end-to-end verification where the project has them (for example the
   bundled `playwright` plugin — `har env add-plugin playwright` — or a project-owned plugin
   scaffolded with `har plugin create <id>` and installed with `har env add-plugin <id>`).
   Pre-existing failures that are unrelated to the environment may be scoped out, but say
   so in `.har/README.md`.
5. `AGENTS.md` and `.har/README.md` explain how to run and verify this project through HAR:
   URLs, ports, credentials, seed data, what "agent usable" means here.
6. No `TODO` placeholders remain in `.har/`.

## Rules for this benchmark

- Edit harness files in the harness root (`{{harness_root}}`): `.har/**`, `AGENTS.md`,
  `CLAUDE.md`, `.claude/**`, `.gitignore`. **Do not change the project's own source, tests,
  configuration or dependency manifests** — if the app cannot run without such a change,
  document the limitation in `.har/README.md` instead.
- You may (and should) run `har env launch 1`, `har env verify 1 [--full]`, `har env status 1`,
  `har env logs 1`, `har env agent 1 …`, `har env teardown 1` yourself to iterate. Only use slot 1.
  **Tear slot 1 down before you finish** (`har env teardown 1 --delete-branch`).
- If the scaffolded profile is wrong for this stack, re-scaffold once with
  `har env init --force --profile default|cli --yes --no-cursor-rule --agents claude --commit-gate never`
  before adapting anything.
- Do not commit. The runner commits the harness once its own gate passes.
- Finish with `har env maintain --finalize --summary "<what you changed>"`, then print a
  summary of: profile, primary app and infra, the verification stages per tier, plugins you
  installed or created, and anything you could not make work.

## The generic HAR adaptation prompt (from `har env init`) — follow it, with the rules above taking precedence

---

{{har_adapt_prompt}}

---

{{failure_context}}

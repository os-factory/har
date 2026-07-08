Adapt this repository's `.har/` harness for coding agents working on SWE-bench style bug fixes.

Repository: {{repo}}
Instance: {{instance_id}}
HAR profile used for scaffold: {{har_profile}}

## Context

`har env init --profile {{har_profile}}` has already been run. The boilerplate `.har/` directory exists but is not yet adapted for this repository.

Do **not** run `har env init --auto`. You must edit the generated harness files directly.

The benchmark runner validates harness readiness **after** your edits. You do not need to launch slots yourself.

## Objectives

1. Make `har env launch 1` succeed for this repository at the current commit.
2. Make `har env verify 1` run meaningful fast checks for this repo (typecheck/lint/unit tests as appropriate).
3. Keep the harness lightweight — SWE-bench grading uses the repo's own test suite, not browser e2e.
4. Document how agents should use the harness in `.har/CLAUDE.agent.md` and `.har/README.md` if needed.

## Explore first

- `README`, `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini`, `Makefile`, CI configs
- how tests are invoked (`pytest`, `python -m pytest`, etc.)
- install / dependency setup commands

## Adapt

- `.har/harness.env` — primary app label, any port bases if needed
- `.har/verify.sh` or stage wiring — real verification commands for this repo
- `.har/launch.sh` — keep worktree-based behavior and **preserve** `--replace` / `--force` flag parsing from the template; do not disable worktrees (`HARNESS_USE_WORKTREE` must stay `true`)
- remove TODO placeholders that would cause verify to fail

## Do NOT during setup

- Do **not** run `har env launch`, `./.har/launch.sh`, or `./.har/verify.sh` — the runner performs launch/verify gates after you finish.
- Do **not** rewrite `launch.sh` into a minimal repo-root-only launcher unless worktree creation is impossible; prefer adapting verify commands and `harness.env`.

## Definition of done

- Edited harness files are ready for the runner to execute `har env launch 1` and `har env verify 1`
- no unused template services or placeholder commands remain

When finished, summarize what you changed and which verify commands will run.

{{setup_failure_context}}

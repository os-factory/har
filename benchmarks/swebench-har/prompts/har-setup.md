Adapt this repository's `.har/` harness for coding agents working on SWE-bench style bug fixes.

Repository: {{repo}}
Instance: {{instance_id}}
HAR profile used for scaffold: {{har_profile}}

## Context

`har env init --profile {{har_profile}}` has already been run. The boilerplate `.har/` directory exists but is not yet adapted for this repository.

Do **not** run `har env init --auto`. You must edit the generated harness files directly.

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
- `.har/launch.sh` behavior should remain worktree-based; do not disable worktrees
- remove TODO placeholders that would cause verify to fail

## Definition of done

- `har env launch 1` succeeds
- `har env verify 1` succeeds (or documents a minimal passing quick verify for this repo's constraints)
- no unused template services or placeholder commands remain

When finished, summarize what you changed and which verify commands now run.

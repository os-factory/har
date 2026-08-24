# .har — Agent Harness (CLI / library profile)

This directory is the **agent harness** for this repository. It lets AI coding agents run the project in isolated git worktrees with optional Docker-backed shared infra.

Generated and maintained by [`har`](https://github.com/os-factory/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Launch a slot to exercise the code in isolation; don't hand-roll setup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

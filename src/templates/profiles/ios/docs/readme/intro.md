# .har — Agent Harness (iOS mobile app profile)

This directory is the **agent harness** for this iOS mobile app repository. It lets AI coding agents build, test, and validate the app in isolated git worktrees against a running iOS Simulator.

Generated and maintained by [`har`](https://github.com/os-factory/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Launch a slot to exercise the code in isolation; don't hand-roll Xcode/simulator setup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

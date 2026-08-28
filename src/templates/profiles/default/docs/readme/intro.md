# .har — Agent Harness

This directory is the **agent harness** for this repository. It lets AI coding agents (Cursor, Claude Code, etc.) run the project in isolated environments with their own ports, database, and verification workflow.

Generated and maintained by [`har`](https://github.com/os-factory/har). Run `har env maintain` when the repo stack changes.

**The harness is how you run this project.** Need the app live — manual testing, a browser session, screenshots? `launch` a slot; don't hand-roll docker/dev-server startup. If a harness command fails, fix the harness or report it — don't silently fall back to ad-hoc commands.

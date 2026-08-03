---
title: Quick start
description: Initialize a harness and complete the first isolated agent session.
---

## 1. Onboard (recommended)

From your project root:

```bash
har onboard
```

The guided wizard walks through how HAR works, then lets you:

- choose agent telemetry (`on` / `on-no-prompts` / `off`)
- start Mission Control
- pick optional plugins (for example Playwright)
- set how many agents may run in parallel (`--agent-slots`, or an interactive prompt)
- scaffold `.har/` for a profile (`default`, `cli`, or `ios`)

It finishes by writing `.har/ADAPT-PROMPT.md` and offering to copy that prompt
to the clipboard so you can paste it into your coding agent.

Non-interactive defaults:

```bash
har onboard --yes --profile cli --no-control --no-plugins
```

### Manual init (equivalent pieces)

```bash
har preferences configure
har env init
```

The preferences wizard stores user-level onboarding defaults in
`~/.har/preferences.json`. It controls Cursor rules, agent skills, and whether
init/maintain should install the commit gate. Explicit command flags still win.

The default profile targets web applications. Use `--profile cli` for libraries
and command-line tools or `--profile ios` for an Xcode project.

To let HAR perform the Claude-based adaptation:

```bash
export ANTHROPIC_API_KEY=...
har env init --auto --yes
```

Review and commit `.har/`, `AGENT.md`, and any generated agent workflows.

## 2. Check readiness

```bash
har env preflight 1
har env status
```

Preflight checks occupied slots, ports, foreign PM2 processes, and Docker conflicts
before a launch changes anything.

## 3. Launch a fresh session

```bash
har env launch 1
```

Launch prints a `workDir`. **Make every application edit under that directory.**
The main checkout is not the session workspace.

Each launch creates a fresh branch and worktree by default. An occupied slot
always blocks a new launch — free it with `har env complete <id>` or
`teardown <id>`, then launch again. Commit or discard uncommitted work in the
worktree first. See [Agent workflow](/docs/guides/agent-workflow/) for occupied
and failed slots.

## 4. Verify

```bash
har env verify 1
har env verify 1 --full
```

Quick verification is the fast feedback loop. Full verification is the completion
gate and may include unit tests, lint, readiness checks, browser E2E, and any
project-defined validation stages.

## 5. Complete and hand off

Commit the verified changes in the session worktree. Agents should present a
[session handoff](/docs/guides/agent-workflow/#what-agents-must-propose) and wait
for approval before finishing. Then:

```bash
har env complete 1
```

`complete` runs full verification, records the exact validated tree hash, removes
the runtime and worktree, and keeps the session branch for a pull request.

If you only need cleanup, use `har env teardown 1`. It also keeps the branch unless
you explicitly pass `--delete-branch`.

## Shell fallback

The generated scripts remain directly usable without a global CLI:

```bash
./.har/setup-infra.sh
./.har/launch.sh 1
./.har/verify.sh 1 --full
./.har/teardown.sh 1
```

Direct scripts do not create persisted `.har/runs/` records; CLI and MCP execution do.

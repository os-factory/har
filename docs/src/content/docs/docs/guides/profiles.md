---
title: Profiles and configuration
description: Choose and adapt the web, CLI, or iOS harness profile.
---

## Built-in profiles

| Profile | Use for | Runtime model |
| --- | --- | --- |
| `default` | Web applications and services | PM2 primary app, per-slot ports, optional shared Docker infrastructure |
| `cli` | CLIs, libraries, packages | Worktree and toolchain only; no PM2 or preview-port assumptions |
| `ios` | Xcode and Swift applications | `xcodebuild`, iOS Simulator settings, optional RocketSim flows |

Choose a profile once when initializing:

```bash
har env init
har env init --profile cli
har env init --profile ios
```

## Adaptation

The scaffold intentionally contains project-specific placeholders. Adapt:

- dependency installation and toolchain detection;
- primary app and process commands;
- readiness and health endpoints;
- infrastructure services, migrations, and seed commands;
- base ports and slot step;
- quick and full verification;
- project-specific environment values.

HAR writes `.har/ADAPT-PROMPT.md` for your coding agent to adapt the scaffold.
Your agent tailors scripts, ports, verification, and `AGENT.md` to the repository.

## Toolchains

Generated harnesses can detect or explicitly configure Node.js, Python, Go, Rust,
Java, Ruby, and iOS toolchains. `HARNESS_INSTALL_CMD` overrides the default install
behavior. Resolved binaries and paths are appended to each slot's environment file.

## Shared and per-slot resources

The web profile distinguishes:

- **shared infrastructure**, such as one Docker Postgres or Redis instance;
- **per-slot state**, such as `agent_1` and `agent_2` databases;
- **per-slot app processes and ports**, calculated from base ports and
  `HARNESS_PORT_STEP`.

Launch prepares shared infrastructure first, then clones or migrates isolated slot
state before starting the primary application.

## Slot limits

Keep the slot range in `.har/stages.json` and `harness.env` aligned:

```json
{
  "agentSlots": {
    "min": 1,
    "max": 3
  }
}
```

The repository, not the HAR binary, decides how much parallelism is safe.

## Root mode

`--no-worktree` is available for exceptional single-checkout workflows:

```bash
har env launch 1 --no-worktree
```

Worktrees remain the default because they separate concurrent tasks and make the
session lifecycle explicit.

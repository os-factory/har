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

Profiles are **ordered compositions** of runtime bundles (shared kernel, optional
PM2 or Xcode helpers, then the profile overlay). The assembled result is still a
flat `.har/` directory — same paths agents and maintain already expect. Init
records the profile and bundle list in `.har/plugins.json`.

Stack capabilities (PM2, Simulator, app ports) are detected from marker files and
env vars, not from the profile name string. See [Plugins](/docs/guides/plugins/)
for how verification plugins relate to profiles (same ledger, different layer).

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
Your agent tailors scripts, ports, verification, and `AGENTS.md` to the repository.

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

## Simulators are the iOS profile's ports

Slots on the iOS profile each get their own iOS Simulator, the way web slots each
get their own ports. Without it, concurrent agents would share one `xcodebuild`
destination, one installed bundle id, and one UI session.

`har env launch` **creates** `har-<project>-agent-<id>-<model>` and teardown deletes
it — `har-storefront-agent-2-iPhone-17`, say.
Creating rather than borrowing keeps the rule short: the device is unique by
construction, it starts pristine on every launch, and a simulator the developer is
using by hand is never taken over.

The model comes from `HARNESS_SIMULATOR_NAME` — a device model such as `iPhone 16`
or `iPad Air 11-inch (M2)`, as listed by `xcrun simctl list devicetypes`. Leave it
empty for the newest model of the family. `HARNESS_SIMULATOR_FAMILY` (`auto`,
`iPhone`, `iPad`) decides that family; `auto` reads it from the configured model,
so an iPad is only created for a harness configured on iPad.

The runtime is the newest installed iOS that supports the model, so a model
retired from recent runtimes still resolves against an older one. When nothing
matches, launch fails and lists the models the machine can create.

The device is written to the slot's `.env.agent.<id>` as
`HARNESS_IOS_DESTINATION=platform=iOS Simulator,id=<udid>` and
`HARNESS_SIMULATOR_DEVICE_NAME`; `HARNESS_SIMULATOR_NAME` keeps meaning the model.
What a slot holds is tracked in `.har/simulators/agent-<id>.json`.

Two escape hatches: `HARNESS_SIMULATOR_UDID` runs every slot on one existing
device, and `HARNESS_SIMULATOR_SHARED=true` goes back to a single shared simulator
resolved by exact name. A `HARNESS_SIMULATOR_NAME` that is not a model but matches
an existing device also selects that device, which is how a hand-renamed simulator
is targeted; devices HAR did not create are never deleted.

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

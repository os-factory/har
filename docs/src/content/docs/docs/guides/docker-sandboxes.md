---
title: Docker Sandboxes
description: Run a coding agent and the HAR CLI inside a Docker Sandbox with the har kit.
---

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`) run a coding
agent in a microVM with its own kernel, filesystem, and Docker Engine. Outbound
network access is denied unless a policy allows it. Use a sandbox when you want to
give the agent broad permissions without giving it access to your host. HAR does
not require a sandbox: the harness behaves the same inside one as on your machine.

The repository ships a sandbox kit, `docker-sbx/har`, that installs Node 24 and
the published `@osfactory/har` CLI when the sandbox is created. It is a
[v3 mixin kit](https://docs.docker.com/ai/sandboxes/customize/author/), so it
works with any agent and needs no image build on the host.

## Prerequisites

- `sbx` 0.45 or later.
- A Docker login for `sbx`: run `sbx login` once.

## Run an agent with the kit

From a checkout of `os-factory/har`, start an agent in your project with the kit:

```bash
sbx run claude --kit ./docker-sbx/har
```

Replace `claude` with another agent, such as `codex`, or with `shell` for a plain
shell. Arguments after `--` go to the agent, so you can hand it a task that uses
the harness:

```bash
sbx run claude --kit ./docker-sbx/har -- -p "Launch HAR slot 1, make the change, then run har env verify 1 --full"
```

Inside the sandbox the agent uses `har env …` and the `.har/` harness as it would
on the host.

## Kit arguments

Set kit arguments with `--kit-arg name=value`:

| Argument | Default | Effect |
| --- | --- | --- |
| `version` | `latest` | `@osfactory/har` npm version or dist-tag to install |
| `telemetry` | `0` | Value of `HAR_TELEMETRY` in the sandbox |

Pin the CLI version to match the harness in your repository:

```bash
sbx run claude --kit ./docker-sbx/har --kit-arg version=1.30.0
```

## Telemetry and Mission Control

The kit turns telemetry off by default. Agent activity is not recorded (HAR's own
default level, `full`, includes prompt text), and the sandbox does not pull or run
[Mission Control](/docs/guides/mission-control/), which collects telemetry over
OTLP. Runs, slots and verification records are written either way. To record agent
activity, pass a level such as `--kit-arg telemetry=usage` (tokens and cost only).

With telemetry on, `har env launch`
starts Mission Control if it is not reachable: it pulls the
`theosfactory/har-control` image and runs it on the sandbox's own Docker Engine.
That instance is separate from Mission Control on your host, its data stays in the
sandbox, and launch waits up to 90 seconds for it to start. Run Mission Control on
the host.

## Network policy

During installation the kit allows outbound access only to `nodejs.org` (Node
tarball and its `SHASUMS256.txt`, which the install verifies) and
`registry.npmjs.org` (`@osfactory/har`). After installation the agent runs under
your sandbox's own network policy; the kit adds nothing to it.

## Test the kit

`docker-sbx/test.sh` creates a sandbox with the kit on a throwaway fixture
repository. It checks the Node, `har`, and telemetry setup, then runs
`har env init`, `launch 1`, `verify 1 --full`, and `teardown 1`, and checks the
slot registry, worktree, and run records.

```bash
docker-sbx/test.sh                # drive har through sbx exec in a shell sandbox
AGENT=claude docker-sbx/test.sh   # Claude drives the harness from a prompt
KEEP=1 docker-sbx/test.sh         # keep the sandbox and fixture for debugging
```

`AGENT=claude` needs Claude credentials in `sbx` and uses tokens. The script needs
`sbx` and `sbx login` on the machine, so it is not part of the harness or CI. Run it
by hand when you change the kit.

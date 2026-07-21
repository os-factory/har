---
title: Upgrade a harness
description: Update HAR without losing repository-specific adaptations.
---

The installed CLI and the checked-in harness evolve independently. Updating the npm
package gives you new CLI, MCP, run-storage, and bundled-template behavior; it does
not rewrite `.har/`.

## Safe upgrade path

```bash
npm install -g @osfactory/har@latest
har env maintain
```

`maintain` validates the current harness and reports:

- generator version drift;
- missing bundled files;
- template checksum differences;
- stale or extra files;
- missing port documentation;
- validation errors.

It writes a maintenance bundle and adaptation prompt where changes need review.
Apply the prompt with a coding agent, or use built-in adaptation:

```bash
har env maintain --auto
```

After a manual adaptation, record the new generator version and checksums:

```bash
har env maintain --finalize --summary "Adopt updated launch and verification scripts"
har env verify 1 --full
```

## Managed integrations

Maintain can add or refresh agent workflows and the Cursor rule:

```bash
har env maintain --agents claude,cursor,codex
har env maintain --cursor-rule
```

Files whose HAR-managed header was removed are treated as user-owned and preserved.

## Avoid destructive reinitialization

Do not use this on an adapted repository:

```bash
har env init --force
```

It replaces the harness scaffold and can discard custom services, ports, stages,
database setup, and verification logic. `maintain` is the upgrade operation;
`init --force` is only appropriate for deliberate recreation.

## After stack changes

Run maintain whenever the repository gains a service, changes install commands,
moves its primary app, introduces new environment variables, or changes the
definition of done. The checked-in scripts should describe the project as it exists
today, not as it looked when HAR was first installed.

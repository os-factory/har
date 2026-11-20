# HAR kit for Docker Sandboxes

`har/` is a [v3 sandbox kit](https://docs.docker.com/ai/sandboxes/customize/author/) (mixin)
that installs Node 24 and the published `@osfactory/har` CLI into any workload at sandbox
creation (install hooks, so no image build / `docker buildx` on the host).

```bash
sbx run claude --kit ./docker-sbx/har     # or: shell, codex, …

# hand the agent a prompt that drives the harness
sbx run claude --kit ./docker-sbx/har -- -p "Launch HAR slot 1, make the change, then run har env verify 1 --full"

# pin the har version
sbx run claude --kit ./docker-sbx/har --kit-arg version=1.30.0
```

Requires `sbx` ≥ 0.45.

| Arg | Default | |
|-----|---------|---|
| `version` | `latest` | `@osfactory/har` npm version or dist-tag |
| `telemetry` | `0` | Sets `HAR_TELEMETRY`. Off by default: with it on, `har env launch` tries to start Mission Control through Docker, which the sandbox does not provide. |

## Test

```bash
docker-sbx/test.sh                # har driven through `sbx exec` in a `shell` sandbox
AGENT=claude docker-sbx/test.sh   # Claude gets a prompt and drives the harness itself
KEEP=1 docker-sbx/test.sh         # keep the sandbox + fixture for debugging
```

Creates a sandbox with the kit on a throwaway fixture repo, checks node 24 / har / telemetry,
runs `har env init`, then `launch 1` → `verify 1 --full` → `teardown 1` and asserts on the slot
registry, worktree and run records. `AGENT=claude` needs Claude credentials in `sbx` and spends tokens.
Not wired into the harness or CI — it needs `sbx` and `sbx login` on the machine.

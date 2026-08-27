## Quick start

**har CLI or MCP:**

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment`.

`./.har/*.sh` exist as compatibility shims over the same runtime — generated,
never edited, and not the way to drive the harness. Take explicit ownership of
them with `har env eject`.

Read **`stages.json`** and **`verificationStages`**. Optional: `har env add-plugin playwright`.

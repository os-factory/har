## Quick start

**har CLI or MCP:**

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment`.

CLI and MCP are the only entry points. `har env eject` vendors the runtime into
`.har/runtime/` for offline ownership (`node .har/runtime/har.cjs env …`).

Read **`stages.json`** and **`verificationStages`**. Optional: `har env add-plugin playwright`.

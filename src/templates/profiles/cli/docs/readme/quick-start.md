## Quick start

**har CLI or MCP:**

```bash
har env launch 1
har env verify 1
har env verify 1 --full
har env teardown 1
```

In Cursor with HAR MCP configured: use `har_launch_environment`, `har_run_verification`, and `har_teardown_environment`.

**Shell shims** (same runtime — each `./.har/*.sh` forwards to `har env`, with a pinned `npx @osfactory/har` fallback):

```bash
./.har/setup-infra.sh          # when HARNESS_INFRA_SERVICES is non-empty
./.har/launch.sh 1
./.har/verify.sh 1             # quick: ecosystem smoke (compile/import/build)
./.har/verify.sh 1 --full      # + conventional tests, lint, browser-e2e (if installed)
./.har/teardown.sh 1
```

Read **`stages.json`** and **`verificationStages`**. Optional: `har env add-plugin playwright`.

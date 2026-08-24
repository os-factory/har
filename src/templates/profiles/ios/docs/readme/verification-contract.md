## Verification contract

Steps in `verify.sh` are **project-specific examples** — adapt them to your stack.
The table describes each tier's intent, not a fixed command list.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` | build smoke (compile-only) |
| Full | `har env verify <id> --full` | + unit tests, lint, optional readiness smoke, **rocketsim-flows** when installed |

For apps that depend on local backends, auth, seeded state, or simulator flows,
distinguish build/test health from agent usability. Document any skipped full
dev setup and add a readiness command when agents need a real workflow to pass.

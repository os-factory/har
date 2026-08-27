## Verification contract

Steps in `har env verify` are **project-specific examples** — adapt them to your stack
during `har env init` / `har env maintain` / benchmark setup. The table describes
each tier's intent, not a fixed command list.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` or `verify.sh <id>` | Stock ecosystem smoke: compile / import / build conventions |
| Full | `har env verify <id> --full` or `verify.sh <id> --full` | Stock conventional tests/lint + optional readiness smoke, **browser-e2e** when `stages/browser-e2e.sh` exists |

The stock commands are deliberately generic conventions keyed by
`HARNESS_ECOSYSTEM`. Replace them with the repository's real commands during
adaptation; do not leave Node/npm, Python, Go, Rust, Java, or Ruby defaults in
place when they do not match the project.

For repos that need runtime services, distinguish health from usability. If the
harness skips slow local-dev setup, document the skipped steps and add a minimal
bootstrap/readiness check when agents need default data, credentials, or an
authenticated workflow.

Use `har env launch 1 --no-worktree` only when working in the repo root.

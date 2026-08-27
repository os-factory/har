## Verification contract

Steps in `har env verify` are **project-specific examples** — adapt them to your stack
during `har env init` / `har env maintain`. The table describes each tier's intent,
not a fixed command list.

| Mode | Command | Typical steps |
|------|---------|---------------|
| Quick | `har env verify <id>` or `verify.sh <id>` | Stock ecosystem smoke + health (stops early on failure) |
| Full | `har env verify <id> --full` or `verify.sh <id> --full` | Stock conventional tests/lint, optional readiness smoke + **`browser-e2e`** when `.har/stages/browser-e2e.sh` exists |

The stock commands are deliberately generic conventions keyed by
`HARNESS_ECOSYSTEM`. Replace them with the repository's real commands during
adaptation; do not leave Node/npm, Python, Go, Rust, Java, or Ruby defaults in
place when they do not match the project.

Install Playwright plugin: `har env add-plugin playwright` (optional). UI changes should add or update specs under `tests/`.

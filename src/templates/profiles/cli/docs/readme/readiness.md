## Readiness

Adapt this section for the repository. For pure CLI/library repos, full verify
may be enough. If the project needs services, auth, seeded data, or a sample
workflow, document the required credentials/default data and wire a smoke into
`HARNESS_READINESS_CMD` or full verify.

When `HARNESS_READINESS_CMD` is a `curl | grep` pipeline, do not use `grep -q`.
The readiness stage runs under `set -o pipefail`; quiet grep exits on the first
match, SIGPIPEs curl (exit 23), and the check fails once the body exceeds the
kernel pipe buffer. Use `grep -c PATTERN >/dev/null` so grep reads to EOF.

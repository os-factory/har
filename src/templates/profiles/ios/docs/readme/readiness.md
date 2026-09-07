## Readiness

Adapt this section for the repository. A successful build/test run does not
always mean an agent can use the app. If the app needs a backend, credentials,
seeded data, or a simulator flow, document it here and wire the smoke into
`HARNESS_READINESS_CMD`, RocketSim flows, or full verify.

When `HARNESS_READINESS_CMD` is a `curl | grep` pipeline, do not use `grep -q`.
The readiness stage runs under `set -o pipefail`; quiet grep exits on the first
match, SIGPIPEs curl (exit 23), and the check fails once the body exceeds the
kernel pipe buffer. Use `grep -c PATTERN >/dev/null` so grep reads to EOF.

#!/usr/bin/env bash
# Writes one artifact file under .har/artifacts/ of the work dir.
set -euo pipefail
mkdir -p .har/artifacts/fixture-report
printf '{"greeting":"%s"}\n' "$(cat src/greeting.txt)" > .har/artifacts/fixture-report/report.json
echo "write-artifact: wrote .har/artifacts/fixture-report/report.json"

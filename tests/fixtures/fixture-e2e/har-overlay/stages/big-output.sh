#!/usr/bin/env bash
# Writes about 1.5 MiB to stdout so the stage log is capped to its last 1 MiB.
set -euo pipefail
echo "big-output: start"
line=$(printf 'x%.0s' $(seq 1 99))
for _ in $(seq 1 16000); do echo "$line"; done
echo "big-output: done"

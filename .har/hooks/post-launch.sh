#!/usr/bin/env bash
# Install the docs workspace deps (docs/package.json) after slot provisioning —
# the packaged runtime installs only the repo-root toolchain. Lifted from the
# pre-1.0 adapted provision-toolchain.sh (1.0 migration, #242).
set -euo pipefail

if [ -f "$WORK_DIR/docs/package.json" ]; then
  echo "Installing documentation dependencies..."
  (cd "$WORK_DIR/docs" && "${NPM_BIN:-npm}" install --no-audit --no-fund)
fi

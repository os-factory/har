#!/usr/bin/env bash
# Install the docs workspace deps (docs/package.json) after slot provisioning —
# the packaged runtime installs only the repo-root toolchain. Lifted from the
# pre-1.0 adapted provision-toolchain.sh (1.0 migration, #242).
set -euo pipefail

if [ -f "$WORK_DIR/docs/package.json" ]; then
  echo "Installing documentation dependencies..."
  # sharp (Astro images) prefers a system libvips when pkg-config finds one and
  # then builds from source, which fails without node-addon-api. Always use the
  # prebuilt @img/sharp-* binaries so the install doesn't depend on the host.
  (cd "$WORK_DIR/docs" && SHARP_IGNORE_GLOBAL_LIBVIPS=1 "${NPM_BIN:-npm}" install --no-audit --no-fund)
fi

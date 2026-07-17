#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: prepare-assets.sh <version>}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/release-assets"

rm -rf "${OUT}"
mkdir -p "${OUT}"

tar -czf "${OUT}/har-cli-${VERSION}.tar.gz" -C "${ROOT}" dist/

cp "${ROOT}/src/templates/har-boilerplate/docker-compose.agent.yml" \
  "${OUT}/docker-compose.agent-web.yml"
cp "${ROOT}/src/templates/har-boilerplate-cli/docker-compose.agent.yml" \
  "${OUT}/docker-compose.agent-cli.yml"
# Mission Control ships as a single self-contained image (SQLite, no compose):
# users run `har control up`, so there is no control compose asset to publish.

echo "Prepared release assets in ${OUT}"

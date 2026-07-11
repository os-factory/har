#!/usr/bin/env bash
set -euo pipefail

# Build and push theosfactory/har-control for the current package.json version.
# Tags: X.Y.Z, X.Y, X, and latest (same as publish-docker.yml / semantic-release).
# Requires: docker with buildx (multi-arch: amd64 + arm64), logged in to
# Docker Hub (docker login). Cross-building arm64 on x86 needs binfmt/QEMU:
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
#
# Usage:
#   ./release/publish-control-image.sh
#   ./release/publish-control-image.sh 0.2.0   # explicit version

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(node -p "require('${ROOT}/package.json').version")}"
IMAGE="${HAR_CONTROL_IMAGE:-theosfactory/har-control}"

CONTROL_VERSION="$(node -p "require('${ROOT}/control/package.json').version")"
SCHEMAS_VERSION="$(node -p "require('${ROOT}/packages/schemas/package.json').version")"

for label_version in \
  "package.json:${VERSION}" \
  "control/package.json:${CONTROL_VERSION}" \
  "packages/schemas/package.json:${SCHEMAS_VERSION}"; do
  FILE="${label_version%%:*}"
  ACTUAL="${label_version#*:}"
  if [ "$ACTUAL" != "$VERSION" ]; then
    echo "${FILE} version (${ACTUAL}) does not match ${VERSION}" >&2
    exit 1
  fi
done

MAJOR="${VERSION%%.*}"
MINOR_PATCH="${VERSION#*.}"
MINOR="${MINOR_PATCH%%.*}"

TAGS=(
  "${IMAGE}:${VERSION}"
  "${IMAGE}:${MAJOR}.${MINOR}"
  "${IMAGE}:${MAJOR}"
  "${IMAGE}:latest"
)

# Multi-arch (amd64 + arm64, so the image runs natively on Apple Silicon).
# buildx cannot load a multi-platform image into the local daemon, so build
# and push happen in one step with every tag attached.
PLATFORMS="${HAR_CONTROL_PLATFORMS:-linux/amd64,linux/arm64}"

TAG_ARGS=()
for tag in "${TAGS[@]}"; do
  TAG_ARGS+=(-t "$tag")
done

echo "Building and pushing ${IMAGE}:${VERSION} (${PLATFORMS}) from ${ROOT}"
docker buildx build \
  --platform "$PLATFORMS" \
  -f "${ROOT}/control/Dockerfile" \
  "${TAG_ARGS[@]}" \
  --push \
  "${ROOT}"

echo "Published ${IMAGE}:${VERSION} (linked to CLI @osfactory/har@${VERSION})"

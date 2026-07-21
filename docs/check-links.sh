#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"

if [ ! -d "$DIST" ]; then
  echo "docs/dist is missing. Run: npm run build --prefix docs" >&2
  exit 1
fi

if ! command -v lychee >/dev/null 2>&1; then
  echo "lychee is required for documentation link checks" >&2
  exit 1
fi

# Absolute asset/nav paths are rooted at `/` (custom domain). Point lychee's
# root-dir at the build output so `/_astro/...` resolves locally. Exclude the
# live site so canonical URLs are not fetched before deploy.
lychee \
  --no-progress \
  --root-dir "$DIST" \
  --exclude '^https://harproject\.cloud' \
  --exclude '^https://www\.npmjs\.com' \
  --exclude '^https://api\.web3forms\.com' \
  --exclude-loopback \
  "$DIST"

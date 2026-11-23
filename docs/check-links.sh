#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
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
#
# Remap GitHub blob/main links to this checkout so docs can link to files added
# in the same PR (e.g. RELEASING.md) without waiting for merge to main.
#
# Gateway errors and rate limits (429, 502-504) are the remote host's outage,
# not a dead link: a GitHub 503 once failed every open PR at the same time.
# Retry them with backoff, then accept them; a 404 still fails the check.
lychee \
  --no-progress \
  --max-retries 5 \
  --retry-wait-time 5 \
  --accept '100..=103,200..=299,429,502..=504' \
  --root-dir "$DIST" \
  --remap "https://github.com/os-factory/har/blob/main/(.*) file://${REPO_ROOT}/\$1" \
  --exclude '^https://harproject\.dev' \
  --exclude '^https://www\.npmjs\.com' \
  --exclude '^https://api\.web3forms\.com' \
  --exclude-loopback \
  "$DIST"

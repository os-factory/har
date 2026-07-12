#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
LYCHEE_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$LYCHEE_ROOT"
}
trap cleanup EXIT

if [ ! -d "$DIST" ]; then
  echo "docs/dist is missing. Run: npm run build --prefix docs" >&2
  exit 1
fi

ln -sfn "$DIST" "$LYCHEE_ROOT/har"

if command -v lychee >/dev/null 2>&1; then
  LYCHEE=(lychee)
else
  echo "lychee is required for documentation link checks" >&2
  exit 1
fi

"${LYCHEE[@]}" \
  --no-progress \
  --root-dir "$LYCHEE_ROOT" \
  --exclude '^https://os-factory\.github\.io/har' \
  --exclude-loopback \
  "$DIST"

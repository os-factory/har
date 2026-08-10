#!/usr/bin/env bash
# Prepare or comment before/after screenshot proof for a GitHub PR.
#
# Usage:
#   ./.har/stages/pr-visual-proof.sh prepare [agent-id]
#       Copy PNGs from artifacts → .har/visual-proof/{before,after}/
#       Then: git add .har/visual-proof && re-run full verify && commit.
#
#   ./.har/stages/pr-visual-proof.sh comment <pr-number>
#       Post a PR comment with markdown images (branch must already contain
#       docs/.har/visual-proof/ on the remote).
#
# Screenshot artifacts usually live on the main checkout under
# docs/.har/artifacts/ (worktree slots still write there).
# visual-proof/ is tracked (not gitignored) so the commit gate can hash it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCS_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DOCS_ROOT/.." && pwd)"

CMD="${1:?Usage: pr-visual-proof.sh prepare|comment <pr-number>}"

# Worktree slots write screenshots on the main checkout's docs/.har/artifacts/.
resolve_main_repo() {
  if [[ -n "${HAR_REPO_ROOT:-}" ]]; then
    echo "$HAR_REPO_ROOT"
    return
  fi
  local common
  common="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common" ]]; then
    # common-dir is <main>/.git (or <main>/.git/worktrees/…)
    common="${common%/worktrees/*}"
    echo "$(cd "$(dirname "$common")" && pwd)"
    return
  fi
  echo "$REPO_ROOT"
}

resolve_shot_root() {
  local candidates=()
  local main_repo shot c
  main_repo="$(resolve_main_repo)"
  candidates+=(
    "$HARNESS_DIR/artifacts/browser-e2e/screenshots"
    "$DOCS_ROOT/.har/artifacts/browser-e2e/screenshots"
    "$main_repo/docs/.har/artifacts/browser-e2e/screenshots"
  )
  for c in "${candidates[@]}"; do
    if [[ -d "$c/after" ]] && compgen -G "$c/after/*.png" >/dev/null; then
      echo "$c"
      return
    fi
  done
  echo "No after screenshots under artifacts (run full verify / browser-e2e first)." >&2
  echo "Looked in:" >&2
  for c in "${candidates[@]}"; do
    echo "  - $c/after" >&2
  done
  exit 1
}

cmd_prepare() {
  local shot_root before_dir after_dir dest name after copied
  shot_root="$(resolve_shot_root)"
  before_dir="$shot_root/before"
  after_dir="$shot_root/after"
  dest="$HARNESS_DIR/visual-proof"

  rm -rf "$dest"
  mkdir -p "$dest/before" "$dest/after"
  copied=0
  for after in "$after_dir"/*.png; do
    [[ -f "$after" ]] || continue
    name="$(basename "$after")"
    cp "$after" "$dest/after/$name"
    copied=$((copied + 1))
    if [[ -f "$before_dir/$name" ]]; then
      cp "$before_dir/$name" "$dest/before/$name"
    fi
  done
  if [[ "$copied" -eq 0 ]]; then
    echo "No PNG files found in $after_dir" >&2
    exit 1
  fi

  echo "Prepared $copied after screenshot(s) under docs/.har/visual-proof/"
  echo "Next:"
  echo "  git add docs/.har/visual-proof"
  echo "  har env verify <id> --full   # commit gate: re-verify after staging"
  echo "  git commit … && git push"
  echo "  ./.har/stages/pr-visual-proof.sh comment <pr>"
}

cmd_comment() {
  local pr branch remote_url owner_repo body_file name before_url after_url
  pr="${1:?Usage: pr-visual-proof.sh comment <pr-number>}"
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI required to post the PR comment." >&2
    exit 1
  fi

  cd "$REPO_ROOT"
  if [[ ! -d "$HARNESS_DIR/visual-proof/after" ]] || ! compgen -G "$HARNESS_DIR/visual-proof/after/*.png" >/dev/null; then
    echo "Missing docs/.har/visual-proof/after/*.png — run: $0 prepare" >&2
    exit 1
  fi

  branch="$(git rev-parse --abbrev-ref HEAD)"
  remote_url="$(git remote get-url origin)"
  owner_repo="$(
    printf '%s\n' "$remote_url" \
      | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##; s#^https://github.com/##'
  )"

  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' EXIT
  {
    echo "## Visual proof"
    echo
    echo "Before/after screenshots from the docs harness (\`browser-e2e\`)."
    echo
    for after in "$HARNESS_DIR/visual-proof/after"/*.png; do
      [[ -f "$after" ]] || continue
      name="$(basename "$after")"
      echo "### \`${name}\`"
      echo
      if [[ -f "$HARNESS_DIR/visual-proof/before/$name" ]]; then
        before_url="https://github.com/${owner_repo}/blob/${branch}/docs/.har/visual-proof/before/${name}?raw=true"
        echo "**Before**"
        echo
        echo "![${name} before](${before_url})"
        echo
      fi
      after_url="https://github.com/${owner_repo}/blob/${branch}/docs/.har/visual-proof/after/${name}?raw=true"
      echo "**After**"
      echo
      echo "![${name} after](${after_url})"
      echo
    done
  } >"$body_file"

  gh pr comment "$pr" --body-file "$body_file"
  echo "Posted visual proof comment on PR #${pr}."
}

case "$CMD" in
  prepare) cmd_prepare ;;
  comment)
    shift
    cmd_comment "$@"
    ;;
  *)
    echo "Usage: pr-visual-proof.sh prepare|comment <pr-number>" >&2
    exit 1
    ;;
esac

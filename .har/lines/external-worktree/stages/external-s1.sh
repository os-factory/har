#!/usr/bin/env bash
# external-s1 — Evidence reaches Mission Control and the portal
#
# Station S1 of the external-worktree factory line (#253).
# Registered in stages.json; deliberately ABSENT from verificationStages —
# run it with: har line gate S1 --line external-worktree
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
. "$HARNESS_DIR/lines/external-worktree/stages/_common.sh" 2>/dev/null ||   . "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/external-s1"
mkdir -p "$ARTIFACTS_DIR"

echo "==> [external-s1 agent-${AGENT_ID}] Evidence reaches Mission Control and the portal" >&2
echo "==> target: $TARGET" >&2
START=$(now_ms)

set +e
OUTPUT=$(cd "$TARGET" && npx jest tests/sync-sources.test.ts tests/sync-external-workspace.test.ts tests/sync-external-workspace-portal.test.ts  2>&1)
EXIT_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/jest.log"
END=$(now_ms)
STATUS="fail"; [ "$EXIT_CODE" = "0" ] && STATUS="pass"
emit_result "external-s1" "$STATUS" "$AGENT_ID" "$(( END - START ))" "$(escape_step_output "$OUTPUT")"
exit "$EXIT_CODE"

#!/usr/bin/env bash
# external-s0 — HAR knows it does not own the checkout
#
# Station S0 of the external-worktree factory line (#253).
# Registered in stages.json; deliberately ABSENT from verificationStages —
# run it with: har line gate S0 --line external-worktree
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_ID="${1:-${AGENT_ID:-1}}"
. "$HARNESS_DIR/lines/external-worktree/stages/_common.sh" 2>/dev/null ||   . "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

TARGET="${WORK_DIR:-$(cd "$HARNESS_DIR/.." && pwd)}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/external-s0"
mkdir -p "$ARTIFACTS_DIR"

echo "==> [external-s0 agent-${AGENT_ID}] HAR knows it does not own the checkout" >&2
echo "==> target: $TARGET" >&2
START=$(now_ms)

set +e
OUTPUT=$(cd "$TARGET" && npx jest tests/external-worktree.test.ts -t detectInPlaceSlotMode 2>&1)
EXIT_CODE=$?
set -e

printf '%s\n' "$OUTPUT" > "$ARTIFACTS_DIR/jest.log"
END=$(now_ms)
STATUS="fail"; [ "$EXIT_CODE" = "0" ] && STATUS="pass"
emit_result "external-s0" "$STATUS" "$AGENT_ID" "$(( END - START ))" "$(escape_step_output "$OUTPUT")"
exit "$EXIT_CODE"

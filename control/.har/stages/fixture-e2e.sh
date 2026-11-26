#!/usr/bin/env bash
# fixture-e2e: the CLI built from this tree, end to end against this slot's
# Mission Control (ADR 0005, implementation plan step 5).
#
# On a fixture repository (tests/fixtures/fixture-e2e, a cli-profile harness
# whose verify has a stage writing > 1 MiB of output and a stage writing an
# artifact under .har/artifacts/), it runs, as a fake Claude Code session:
#
#   env init → hooks install → env launch 1 --work-id fx-1 → change a file →
#   env verify 1 --full → git commit (Factory Commits trailers) →
#   telemetry flush → env complete 1
#
# and checks Mission Control's work unit view after the commit and after
# complete (fixture-e2e-assert.mjs).
#
# Isolation: every CLI call runs with a clean environment, a throwaway HOME and
# the slot's Mission Control as the only receiver (HAR_CONTROL_API_URL,
# HAR_DESTINATIONS_DIR, HAR_INGEST_QUEUE_DIR, HAR_SESSIONS_DIR under a temp
# dir). Nothing touches the real ~/.har, ~/.claude or the shared Mission Control.
#
# Usage: ./.har/stages/fixture-e2e.sh <agent-id>
# Env:   HAR_FIXTURE_E2E_CONTROL_URL  receiver (default: this slot's http://localhost:$API_PORT)
#        HAR_FIXTURE_E2E_GIT_FACTORY  git-factory executable (default: on PATH, else npm-installed)
#        HAR_FIXTURE_E2E_KEEP=1       keep the temp dir for debugging
set -euo pipefail

HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STAGES_DIR="$HARNESS_DIR/stages"
AGENT_ID="${1:-${AGENT_ID:?Usage: fixture-e2e.sh <agent-id>}}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
# control/ is the app; the CLI and the fixture live in the monorepo root above it.
MONOREPO_ROOT="$(cd "$WORK_DIR/.." && pwd)"
FIXTURE="$MONOREPO_ROOT/tests/fixtures/fixture-e2e"
CLI="$MONOREPO_ROOT/dist/index.js"
CONTROL_URL="${HAR_FIXTURE_E2E_CONTROL_URL:-http://localhost:${API_PORT:?API_PORT not set — run har env launch ${AGENT_ID} first}}"
CONTROL_URL="${CONTROL_URL%/}"
WORK_ID="fx-1"

log() { echo "==> [fixture-e2e agent-$AGENT_ID] $*" >&2; }
fail() { echo "fixture-e2e: $*" >&2; exit 1; }

[ -d "$FIXTURE/project" ] || fail "missing fixture at $FIXTURE"
curl -sf "$CONTROL_URL/api/v2/capabilities" >/dev/null || fail "no ingest v2 receiver at $CONTROL_URL (is the slot's Mission Control up?)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/har-fixture-e2e.XXXXXX")"
cleanup() {
  if [ "${HAR_FIXTURE_E2E_KEEP:-0}" = "1" ]; then log "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
mkdir -p "$TMP/home" "$TMP/bin" "$TMP/repo"

# --- the CLI under test: built from this tree -------------------------------
log "building the CLI in $MONOREPO_ROOT"
if [ ! -x "$MONOREPO_ROOT/node_modules/.bin/esbuild" ]; then
  (cd "$MONOREPO_ROOT" && npm ci --ignore-scripts --no-audit --no-fund >&2)
fi
(cd "$MONOREPO_ROOT" && npm run --silent build >&2)
[ -f "$CLI" ] || fail "build produced no $CLI"
log "CLI under test: $CLI ($(node "$CLI" --version))"

# --- git-factory (Factory Commits proofs and trailers) -----------------------
GIT_FACTORY="${HAR_FIXTURE_E2E_GIT_FACTORY:-$(command -v git-factory || true)}"
if [ -z "$GIT_FACTORY" ]; then
  log "installing @osfactory/factory-proof into the temp dir"
  npm install --prefix "$TMP/factory-proof" --no-audit --no-fund @osfactory/factory-proof >&2
  GIT_FACTORY="$TMP/factory-proof/node_modules/.bin/git-factory"
fi
[ -x "$GIT_FACTORY" ] || fail "git-factory not executable: $GIT_FACTORY"
ln -s "$GIT_FACTORY" "$TMP/bin/git-factory"
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$(command -v node)" "$CLI" > "$TMP/bin/har"
chmod +x "$TMP/bin/har"

# --- otel-hook: launch installs the pinned release into ~/.har/otel-hooks.
# Agents never run here, so a stub at the pinned version stands in for it.
PIN="$(sed -n "s/^export const OTEL_HOOKS_VERSION = '\([^']*\)'.*/\1/p" "$MONOREPO_ROOT/src/core/otel-hooks.ts")"
[ -n "$PIN" ] || fail "cannot read OTEL_HOOKS_VERSION from src/core/otel-hooks.ts"
HOOKS_MODULES="$TMP/home/.har/otel-hooks/node_modules"
mkdir -p "$HOOKS_MODULES/@osfactory/otel-hook" "$HOOKS_MODULES/.bin"
printf '{"name":"@osfactory/otel-hook","version":"%s"}\n' "$PIN" > "$HOOKS_MODULES/@osfactory/otel-hook/package.json"
printf '#!/bin/sh\nexit 0\n' > "$HOOKS_MODULES/.bin/otel-hook"
chmod +x "$HOOKS_MODULES/.bin/otel-hook"

RUN_TAG="$(date +%s)-$$"
REPO_URL="https://example.test/har-fixture-e2e/$RUN_TAG.git"
SESSION_ID="fx-session-$RUN_TAG"

# Clean environment for every CLI and git call: nothing from the slot's env
# file (HAR_CONTROL_API_URL, OTEL_*) or from the agent running this verify.
sandbox() {
  env -i \
    PATH="$TMP/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" \
    HOME="$TMP/home" \
    TMPDIR="$TMP" \
    TERM=dumb \
    HAR_CONTROL_API_URL="$CONTROL_URL" \
    HAR_DESTINATIONS_DIR="$TMP/destinations" \
    HAR_INGEST_QUEUE_DIR="$TMP/queue" \
    HAR_SESSIONS_DIR="$TMP/sessions" \
    GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test \
    GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test \
    "$@"
}
# The agent session: Claude Code's session variable, as its child processes see it.
as_agent() { sandbox CLAUDE_CODE_SESSION_ID="$SESSION_ID" "$@"; }

# --- the fixture repository --------------------------------------------------
log "fixture repository $TMP/repo ($REPO_URL)"
cp -R "$FIXTURE/project/." "$TMP/repo/"
cd "$TMP/repo"
sandbox git init -q -b main
sandbox git remote add origin "$REPO_URL"
sandbox git add -A
sandbox git commit -qm "fixture project"

log "har env init --profile cli (the runtime, incl. the stage runner, from the built CLI)"
sandbox har env init --profile cli --yes --no-agents --no-cursor-rule --commit-gate never >&2
cp "$FIXTURE"/har-overlay/stages/*.sh .har/stages/
node "$STAGES_DIR/fixture-e2e-assert.mjs" overlay "$FIXTURE/har-overlay/stages.patch.json" .har
sandbox git add -A
sandbox git commit -qm "harness"
sandbox har hooks install >&2

log "har env launch 1 --work-id $WORK_ID (session $SESSION_ID)"
as_agent har env launch 1 --work-id "$WORK_ID" --work-title "Fixture e2e" >&2
SLOT_DIR="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".har/slots/agent-1.json","utf8")).workDir)')"
[ -d "$SLOT_DIR" ] || fail "launch left no work dir"

echo "hello, factory" > "$SLOT_DIR/src/greeting.txt"
log "har env verify 1 --full"
as_agent har env verify 1 --full >&2

log "git commit (hooks add the Factory Commits trailers)"
(cd "$SLOT_DIR" && as_agent git add -A && as_agent git commit -qm "Change the greeting")
COMMIT="$(cd "$SLOT_DIR" && sandbox git rev-parse HEAD)"
(cd "$SLOT_DIR" && sandbox git log -1 --format=%B) > "$TMP/commit-message.txt"

log "har telemetry flush"
sandbox har telemetry flush >&2

ASSERT=(node "$STAGES_DIR/fixture-e2e-assert.mjs")
"${ASSERT[@]}" committed "$CONTROL_URL" "$WORK_ID" "$REPO_URL" "$SESSION_ID" "$COMMIT" "$TMP/commit-message.txt"

log "har env complete 1"
as_agent har env complete 1 >&2
sandbox har telemetry flush >&2
"${ASSERT[@]}" completed "$CONTROL_URL" "$WORK_ID" "$REPO_URL" "$SESSION_ID"

echo "fixture-e2e: pass (work unit $WORK_ID of $REPO_URL, commit $COMMIT)"

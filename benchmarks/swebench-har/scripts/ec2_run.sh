#!/usr/bin/env bash
# Full SWE-bench HAR pipeline for EC2 (batch + official eval + comparison).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCHMARK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BENCHMARK_ROOT}/../.." && pwd)"

COUNT="${COUNT:-10}"
SEED="${SEED:-42}"
ARM="${ARM:-both}"
SKIP_BOOTSTRAP=0
SKIP_EVAL=0
DRY_RUN=0
CLEAR_CACHE=1

log() { printf '==> %s\n' "$*"; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --count N           Instances to sample (default: ${COUNT})
  --seed N            Sample seed (default: ${SEED})
  --arm raw|har|both  Arms to run (default: ${ARM})
  --bootstrap         Run ec2_bootstrap.sh first
  --skip-bootstrap    Do not bootstrap (default)
  --skip-eval         Skip official Docker evaluation
  --keep-cache        Do not clear .har-cache before batch
  --dry-run           Orchestration dry-run (no Codex / no Docker eval work)
  -h, --help          Show help

Env:
  COUNT SEED ARM OPENAI_API_KEY HF_TOKEN ARTIFACT_S3_URI
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --arm) ARM="$2"; shift 2 ;;
    --bootstrap) SKIP_BOOTSTRAP=0; DO_BOOTSTRAP=1; shift ;;
    --skip-bootstrap) SKIP_BOOTSTRAP=1; shift ;;
    --skip-eval) SKIP_EVAL=1; shift ;;
    --keep-cache) CLEAR_CACHE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) log "Unknown arg: $1"; usage; exit 1 ;;
  esac
done
DO_BOOTSTRAP="${DO_BOOTSTRAP:-0}"

# Non-interactive PATH for nvm / uv
export PATH="${HOME}/.local/bin:${PATH}"
if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "${HOME}/.nvm/nvm.sh"
fi

if [[ "${DO_BOOTSTRAP}" -eq 1 ]]; then
  bash "${SCRIPT_DIR}/ec2_bootstrap.sh"
fi

cd "${BENCHMARK_ROOT}"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

export HAR_BIN="${HAR_BIN:-${REPO_ROOT}/dist/index.js}"
export HAR_CONFIRM_REPLACE=1

preflight() {
  log "Preflight checks"
  if [[ ! -f "${HAR_BIN}" ]] && ! command -v har >/dev/null 2>&1; then
    log "ERROR: HAR CLI not found (HAR_BIN=${HAR_BIN})"
    exit 1
  fi
  if [[ -f "${HAR_BIN}" ]]; then
    node "${HAR_BIN}" --version >/dev/null || node "${HAR_BIN}" --help >/dev/null
    log "HAR_BIN OK (${HAR_BIN})"
  fi
  if ! docker info >/dev/null 2>&1; then
    if sudo docker info >/dev/null 2>&1; then
      log "WARNING: using sudo for docker"
    else
      log "ERROR: Docker not available"
      exit 1
    fi
  else
    log "Docker OK"
  fi
  if [[ -z "${OPENAI_API_KEY:-}" && "${DRY_RUN}" -eq 0 ]]; then
    log "ERROR: OPENAI_API_KEY is required"
    exit 1
  fi
  uv run scripts/test_swebench_har.py
  log "Smoke tests passed"
}

preflight

mkdir -p logs results
TS="$(date -u +%Y%m%d-%H%M%S)"
BATCH_LOG="logs/ec2-batch-${TS}.log"

if [[ "${CLEAR_CACHE}" -eq 1 ]]; then
  log "Clearing .har-cache (launch/verify contracts may have changed)"
  rm -rf .har-cache
fi

BATCH_ARGS=(scripts/run_batch.py --count "${COUNT}" --seed "${SEED}" --arm "${ARM}")
if [[ "${DRY_RUN}" -eq 1 ]]; then
  BATCH_ARGS+=(--dry-run)
fi

log "Starting batch: count=${COUNT} seed=${SEED} arm=${ARM} (log=${BATCH_LOG})"
set -o pipefail
uv run "${BATCH_ARGS[@]}" 2>&1 | tee "${BATCH_LOG}"
set +o pipefail

BATCH_ID="$(python3 - <<'PY'
import json, pathlib
batches = sorted((pathlib.Path("batches")).glob("*/batch.json"), key=lambda p: p.stat().st_mtime)
if not batches:
    raise SystemExit("no batch.json written")
print(json.loads(batches[-1].read_text())["batch_id"])
PY
)"
log "Batch id: ${BATCH_ID}"

if [[ "${SKIP_EVAL}" -eq 0 ]]; then
  EVAL_ARGS=(scripts/evaluate_batch.py --batch-id "${BATCH_ID}")
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    EVAL_ARGS+=(--dry-run)
  fi
  log "Running official evaluation for batch ${BATCH_ID}"
  uv run "${EVAL_ARGS[@]}" 2>&1 | tee "logs/ec2-eval-${TS}.log"
else
  log "Skipping evaluation (--skip-eval)"
fi

if [[ -n "${ARTIFACT_S3_URI:-}" ]]; then
  log "Syncing artifacts to ${ARTIFACT_S3_URI}"
  aws s3 sync batches "${ARTIFACT_S3_URI%/}/batches" || true
  aws s3 sync results "${ARTIFACT_S3_URI%/}/results" || true
  aws s3 sync logs "${ARTIFACT_S3_URI%/}/logs" || true
fi

log "Done. Comparison: results/ec2-comparison.json"
if [[ -f results/ec2-comparison.json ]]; then
  cat results/ec2-comparison.json
fi

#!/usr/bin/env bash
# Sequential overnight campaign (protocol v2). See OVERNIGHT-PLAN.md.
#
#   nohup bash scripts/overnight.sh > logs/overnight-$(date +%Y%m%d-%H%M).log 2>&1 &
#
# One runner at a time is enforced by a flock inside the runner itself; every phase uses
# --resume, so re-running this script after an interruption continues where it stopped.
set -uo pipefail
cd "$(dirname "$0")/.."

MIN_FREE_GB=${MIN_FREE_GB:-8}

phase() {
  local label="$1"; shift
  local free
  free=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
  if [ "${free:-0}" -lt "$MIN_FREE_GB" ]; then
    echo "== SKIP $label — only ${free}GB free (min ${MIN_FREE_GB}GB)"
    return 0
  fi
  echo "== PHASE $label started $(date -Is) (${free}GB free)"
  uv run --quiet python "$@"
  echo "== PHASE $label finished $(date -Is) rc=$?"
}

# 1. the five v1-graded instances, now under protocol v2
phase "1a marked (2 oldest)" scripts/run_campaign.py --datasets swebench-mm-dev --repos markedjs/marked --limit-per-repo 2 --arm both --resume
phase "1b fastapi template (3)" scripts/run_campaign.py --datasets newtypebench --repos fastapi/full-stack-fastapi-template --arm both --resume

# 2. the large FastAPI service
phase "2 mcp-context-forge (6 oldest)" scripts/run_campaign.py --datasets newtypebench --repos IBM/mcp-context-forge --limit-per-repo 6 --arm both --resume

# 3. one repository at depth
phase "3 marked (all dev instances)" scripts/run_campaign.py --datasets swebench-mm-dev --repos markedjs/marked --arm both --resume

# 4. B' ablation over everything already run
phase "4a ablation marked" scripts/run_campaign.py --datasets swebench-mm-dev --repos markedjs/marked --arm raw_verify --resume
phase "4b ablation backend" scripts/run_campaign.py --datasets newtypebench --repos fastapi/full-stack-fastapi-template IBM/mcp-context-forge --limit-per-repo 6 --arm raw_verify --resume

# 5. hardest stratum last: a fresh task-blind adaptation of a browser-test repository
phase "5 Chart.js (3 oldest, fresh adaptation)" scripts/run_campaign.py --datasets swebench-mm-dev --repos chartjs/Chart.js --limit-per-repo 3 --arm both --resume

phase "report" scripts/report.py
echo "== OVERNIGHT DONE $(date -Is)"

#!/usr/bin/env bash
# Idempotent host bootstrap for SWE-bench HAR on Amazon Linux / ec2-user.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCHMARK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BENCHMARK_ROOT}/../.." && pwd)"

log() { printf '==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

ensure_packages() {
  if have dnf; then
    sudo dnf install -y git gcc gcc-c++ make tar gzip which tmux 2>/dev/null || true
  elif have yum; then
    sudo yum install -y git gcc gcc-c++ make tar gzip which tmux 2>/dev/null || true
  fi
}

ensure_docker() {
  if ! have docker; then
    log "Installing Docker..."
    if have dnf; then
      sudo dnf install -y docker
    else
      sudo yum install -y docker
    fi
  fi
  if ! sudo systemctl is-active --quiet docker 2>/dev/null; then
    sudo systemctl enable --now docker || sudo service docker start || true
  fi
  if ! groups | tr ' ' '\n' | grep -qx docker; then
    log "Adding ${USER} to docker group (may need re-login)"
    sudo usermod -aG docker "$USER" || true
  fi
  if ! docker info >/dev/null 2>&1; then
    if sudo docker info >/dev/null 2>&1; then
      log "WARNING: docker requires sudo for ${USER}; eval will use sudo docker via DOCKER_HOST if needed"
    else
      log "ERROR: Docker daemon not reachable"
      exit 1
    fi
  fi
}

ensure_node() {
  if have node; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "${major}" -ge 20 ]]; then
      log "Node $(node -v) OK"
      return
    fi
  fi
  log "Installing Node 20 via nvm..."
  export NVM_DIR="${HOME}/.nvm"
  if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh"
  nvm install 20
  nvm use 20
  nvm alias default 20
}

ensure_uv() {
  if have uv; then
    log "uv $(uv --version) OK"
    return
  fi
  log "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${HOME}/.local/bin:${PATH}"
}

ensure_har_cli() {
  log "Building HAR CLI at ${REPO_ROOT}"
  cd "${REPO_ROOT}"
  # Ensure nvm node is on PATH for non-interactive shells
  if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "${HOME}/.nvm/nvm.sh"
  fi
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  npm run build
  if [[ -f "${REPO_ROOT}/dist/index.js" ]]; then
    chmod +x "${REPO_ROOT}/dist/index.js" || true
    export HAR_BIN="${REPO_ROOT}/dist/index.js"
    log "HAR_BIN=${HAR_BIN}"
  fi
}

ensure_benchmark_deps() {
  log "Syncing swebench-har Python deps"
  cd "${BENCHMARK_ROOT}"
  export PATH="${HOME}/.local/bin:${PATH}"
  uv sync
}

ensure_env_local() {
  local env_file="${BENCHMARK_ROOT}/.env.local"
  if [[ -f "${env_file}" ]]; then
    log ".env.local already present"
    return
  fi
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    # Common location on this benchmark host
    if [[ -f "${HOME}/aicore/benchmark/.env" ]]; then
      # shellcheck disable=SC1091
      set -a
      # Only pull keys we care about
      OPENAI_API_KEY="$(grep -E '^OPENAI_API_KEY=' "${HOME}/aicore/benchmark/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
      set +a
      export OPENAI_API_KEY
    fi
  fi
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    log "ERROR: OPENAI_API_KEY not set and could not load from ~/aicore/benchmark/.env"
    log "Export OPENAI_API_KEY then re-run bootstrap."
    exit 1
  fi
  {
    echo "OPENAI_API_KEY=${OPENAI_API_KEY}"
    [[ -n "${OPENAI_MODEL:-}" ]] && echo "OPENAI_MODEL=${OPENAI_MODEL}"
    [[ -n "${OPENAI_SETUP_MODEL:-}" ]] && echo "OPENAI_SETUP_MODEL=${OPENAI_SETUP_MODEL}"
    [[ -n "${HF_TOKEN:-}" ]] && echo "HF_TOKEN=${HF_TOKEN}"
    echo "HAR_BIN=${REPO_ROOT}/dist/index.js"
  } >"${env_file}"
  chmod 600 "${env_file}"
  log "Wrote ${env_file}"
}

disk_check() {
  local avail_gb
  avail_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
  log "Disk free: ${avail_gb}G"
  if [[ "${avail_gb}" -lt 40 ]]; then
    log "WARNING: less than 40G free; SWE-bench Docker images may fill the disk"
  fi
}

main() {
  log "Bootstrap starting (repo=${REPO_ROOT})"
  disk_check
  ensure_packages
  ensure_docker
  ensure_node
  ensure_uv
  ensure_har_cli
  ensure_benchmark_deps
  ensure_env_local
  log "Bootstrap complete"
  log "Next: bash ${SCRIPT_DIR}/ec2_run.sh"
}

main "$@"

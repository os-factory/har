#!/usr/bin/env bash
# Provision the project toolchain and append resolved paths to .env.agent.<id>.
# Called from launch.sh after the agent env file is created.
#
# Configure in harness.env:
#   HARNESS_ECOSYSTEM   — auto (default) | node | python | go | rust | java | ruby | ios | none
#   HARNESS_INSTALL_CMD — optional override (eval in HAR_WORK_DIR)
# Ecosystem-specific optional overrides:
#   HARNESS_PYTHON_VENV_DIR — Python venv path relative to HAR_WORK_DIR (default: .har/venv)
#
# Required env from caller: HAR_WORK_DIR, HAR_ENV_FILE
# Optional: HAR_WORKTREE_DIR, HAR_REL_PREFIX, HAR_AGENT_ID (for logging)
set -euo pipefail

: "${HAR_WORK_DIR:?HAR_WORK_DIR is required}"
: "${HAR_ENV_FILE:?HAR_ENV_FILE is required}"

HAR_WORKTREE_DIR="${HAR_WORKTREE_DIR:-}"
HAR_REL_PREFIX="${HAR_REL_PREFIX:-}"
HAR_AGENT_ID="${HAR_AGENT_ID:-}"

pt_log() {
  if [ -n "$HAR_AGENT_ID" ]; then
    echo "==> [agent-${HAR_AGENT_ID}] toolchain: $*" >&2
  else
    echo "==> [provision-toolchain] $*" >&2
  fi
}

append_env() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "$key" "$value" >> "$HAR_ENV_FILE"
}

append_path_prefix() {
  local prefix="$1"
  [ -n "$prefix" ] && [ -d "$prefix" ] || return 0
  append_env "PATH" "${prefix}:${PATH:-$PATH}"
}

detect_ecosystem() {
  local dir="$1"
  local configured="${HARNESS_ECOSYSTEM:-auto}"
  if [ -n "$configured" ] && [ "$configured" != "auto" ]; then
    echo "$configured"
    return
  fi
  if [ -f "$dir/package.json" ]; then echo node; return; fi
  if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/setup.py" ] || [ -f "$dir/setup.cfg" ] \
    || [ -f "$dir/requirements.txt" ] || [ -f "$dir/Pipfile" ]; then
    echo python
    return
  fi
  if [ -f "$dir/go.mod" ]; then echo go; return; fi
  if [ -f "$dir/Cargo.toml" ]; then echo rust; return; fi
  if [ -f "$dir/pom.xml" ] || [ -f "$dir/build.gradle" ] || [ -f "$dir/build.gradle.kts" ]; then
    echo java
    return
  fi
  if [ -f "$dir/Gemfile" ]; then echo ruby; return; fi
  if [ -n "${HARNESS_XCODE_SCHEME:-}" ] || [ -n "${HARNESS_XCODE_PROJECT:-}" ] \
    || [ -n "${HARNESS_XCODE_WORKSPACE:-}" ]; then
    echo ios
    return
  fi
  echo none
}

run_install_cmd() {
  local dir="$1"
  if [ -n "${HARNESS_INSTALL_CMD:-}" ]; then
    pt_log "Running HARNESS_INSTALL_CMD..."
    (cd "$dir" && eval "$HARNESS_INSTALL_CMD")
    return
  fi
  return 1
}

provision_node() {
  local dir="$1"
  local npm_bin="npm"
  local node_bin="node"

  if ! run_install_cmd "$dir"; then
    pt_log "Installing Node dependencies..."
    if [ -f "$dir/pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
      (cd "$dir" && pnpm install --silent)
      npm_bin="pnpm"
    elif [ -f "$dir/yarn.lock" ] && command -v yarn >/dev/null 2>&1; then
      (cd "$dir" && yarn install --silent)
      npm_bin="yarn"
    else
      (cd "$dir" && npm install --silent)
    fi
  fi

  if command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  fi
  if [ "$npm_bin" = "npm" ] && command -v npm >/dev/null 2>&1; then
    npm_bin="$(command -v npm)"
  fi

  append_env "HARNESS_ECOSYSTEM" "node"
  append_env "NODE_BIN" "$node_bin"
  append_env "NPM_BIN" "$npm_bin"
  append_path_prefix "$dir/node_modules/.bin"
}

provision_python() {
  local dir="$1"
  local venv_rel="${HARNESS_PYTHON_VENV_DIR:-.har/venv}"
  local venv_dir="$dir/$venv_rel"
  local python_bin="python3"

  if ! command -v python3 >/dev/null 2>&1; then
    pt_log "python3 not found on PATH — skipping venv provisioning"
    append_env "HARNESS_ECOSYSTEM" "python"
    append_env "PYTHON_BIN" "${PYTHON_BIN:-python3}"
    return
  fi

  if [ ! -d "$venv_dir" ]; then
    pt_log "Creating Python venv at $venv_rel..."
    if ! python3 -m venv "$venv_dir"; then
      rm -rf "$venv_dir"
      pt_log "python3 -m venv failed (on Debian/Ubuntu install python3-venv) — using system python3"
      append_env "HARNESS_ECOSYSTEM" "python"
      append_env "PYTHON_BIN" "$(command -v python3)"
      return
    fi
  fi

  if [ ! -x "$venv_dir/bin/python" ]; then
    pt_log "Python venv at $venv_rel is missing or broken — using system python3"
    append_env "HARNESS_ECOSYSTEM" "python"
    append_env "PYTHON_BIN" "$(command -v python3)"
    return
  fi

  python_bin="$venv_dir/bin/python"
  # shellcheck disable=SC1091
  source "$venv_dir/bin/activate"

  if ! run_install_cmd "$dir"; then
    pt_log "Installing Python dependencies..."
    if [ -f "$dir/pyproject.toml" ]; then
      (cd "$dir" && pip install -q -e ".[dev]" 2>/dev/null) || (cd "$dir" && pip install -q -e .)
    elif [ -f "$dir/requirements.txt" ]; then
      (cd "$dir" && pip install -q -r requirements.txt)
    elif [ -f "$dir/setup.py" ] || [ -f "$dir/setup.cfg" ]; then
      (cd "$dir" && pip install -q -e .)
    elif [ -f "$dir/Pipfile" ] && command -v pipenv >/dev/null 2>&1; then
      (cd "$dir" && pipenv install --dev)
      python_bin="$(cd "$dir" && pipenv --py)"
    fi
  fi

  append_env "HARNESS_ECOSYSTEM" "python"
  append_env "PYTHON_BIN" "$python_bin"
  append_env "VIRTUAL_ENV" "$venv_dir"
  append_path_prefix "$venv_dir/bin"
}

provision_go() {
  local dir="$1"
  if ! run_install_cmd "$dir"; then
    if command -v go >/dev/null 2>&1; then
      pt_log "Downloading Go modules..."
      (cd "$dir" && go mod download)
    else
      pt_log "go not found on PATH — record paths only"
    fi
  fi
  append_env "HARNESS_ECOSYSTEM" "go"
  append_env "GO_BIN" "$(command -v go 2>/dev/null || echo go)"
  if [ -n "${GOPATH:-}" ]; then append_env "GOPATH" "$GOPATH"; fi
  if [ -n "${GOROOT:-}" ]; then append_env "GOROOT" "$GOROOT"; fi
}

provision_rust() {
  local dir="$1"
  if ! run_install_cmd "$dir"; then
    if command -v cargo >/dev/null 2>&1; then
      pt_log "Fetching Rust dependencies..."
      (cd "$dir" && cargo fetch)
    else
      pt_log "cargo not found on PATH — record paths only"
    fi
  fi
  append_env "HARNESS_ECOSYSTEM" "rust"
  append_env "CARGO_BIN" "$(command -v cargo 2>/dev/null || echo cargo)"
  append_env "RUSTC_BIN" "$(command -v rustc 2>/dev/null || echo rustc)"
}

provision_java() {
  local dir="$1"
  run_install_cmd "$dir" || true
  append_env "HARNESS_ECOSYSTEM" "java"
  if [ -n "${JAVA_HOME:-}" ]; then
    append_env "JAVA_HOME" "$JAVA_HOME"
    append_path_prefix "$JAVA_HOME/bin"
  fi
  if command -v mvn >/dev/null 2>&1; then
    append_env "MVN_BIN" "$(command -v mvn)"
  elif [ -f "$dir/gradlew" ]; then
    append_env "GRADLE_BIN" "$dir/gradlew"
  elif command -v gradle >/dev/null 2>&1; then
    append_env "GRADLE_BIN" "$(command -v gradle)"
  fi
}

provision_ruby() {
  local dir="$1"
  if ! run_install_cmd "$dir"; then
    if command -v bundle >/dev/null 2>&1; then
      pt_log "Installing Ruby gems..."
      (cd "$dir" && bundle install --quiet)
    else
      pt_log "bundle not found on PATH — record paths only"
    fi
  fi
  append_env "HARNESS_ECOSYSTEM" "ruby"
  append_env "RUBY_BIN" "$(command -v ruby 2>/dev/null || echo ruby)"
  append_env "BUNDLE_BIN" "$(command -v bundle 2>/dev/null || echo bundle)"
  append_path_prefix "$dir/vendor/bundle/bin"
}

provision_ios() {
  local dir="$1"
  run_install_cmd "$dir" || true
  append_env "HARNESS_ECOSYSTEM" "ios"
  append_env "XCODEBUILD_BIN" "$(command -v xcodebuild 2>/dev/null || echo xcodebuild)"
  if [ -n "${HARNESS_XCODE_SCHEME:-}" ]; then
    append_env "HARNESS_XCODE_SCHEME" "$HARNESS_XCODE_SCHEME"
  fi
  if [ -n "${HARNESS_SIMULATOR_NAME:-}" ]; then
    append_env "HARNESS_SIMULATOR_NAME" "$HARNESS_SIMULATOR_NAME"
  fi
  if [ -n "${HARNESS_BUNDLE_ID:-}" ]; then
    append_env "HARNESS_BUNDLE_ID" "$HARNESS_BUNDLE_ID"
  fi
  if [ -n "${DEVELOPER_DIR:-}" ]; then
    append_env "DEVELOPER_DIR" "$DEVELOPER_DIR"
  fi
}

provision_monorepo_root() {
  [ -n "$HAR_REL_PREFIX" ] || return 0
  [ -n "$HAR_WORKTREE_DIR" ] || return 0
  [ -f "$HAR_WORKTREE_DIR/package.json" ] || return 0
  [ -d "$HAR_WORKTREE_DIR/node_modules" ] && return 0
  pt_log "Installing monorepo root dependencies in $HAR_WORKTREE_DIR..."
  (cd "$HAR_WORKTREE_DIR" && npm install --silent)
}

provision_ecosystem() {
  local dir="$1"
  local ecosystem
  ecosystem="$(detect_ecosystem "$dir")"
  pt_log "Toolchain ecosystem: ${ecosystem} (work dir: ${dir})"

  case "$ecosystem" in
    node) provision_node "$dir" ;;
    python) provision_python "$dir" ;;
    go) provision_go "$dir" ;;
    rust) provision_rust "$dir" ;;
    java) provision_java "$dir" ;;
    ruby) provision_ruby "$dir" ;;
    ios) provision_ios "$dir" ;;
    none)
      if run_install_cmd "$dir"; then
        append_env "HARNESS_ECOSYSTEM" "custom"
      else
        pt_log "No ecosystem manifest detected — set HARNESS_ECOSYSTEM or HARNESS_INSTALL_CMD in harness.env"
        append_env "HARNESS_ECOSYSTEM" "none"
      fi
      ;;
  esac
}

append_env "HARNESS_TOOLCHAIN_PROVISIONED" "true"
provision_ecosystem "$HAR_WORK_DIR"
provision_monorepo_root

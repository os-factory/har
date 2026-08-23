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

# ── Node package manager helpers ──────────────────────────────────────────────
# Single-sourced from lib/node-pm.sh (installed as .har/lib/node-pm.sh) so this
# subprocess and every harness.env-sourcing script resolve the same tool.
# HAR_NODE_PM_LIB overrides the path when the script is sourced from a stream.
_har_node_pm_lib="${HAR_NODE_PM_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/node-pm.sh}"
if [ -f "$_har_node_pm_lib" ]; then
  # shellcheck source=/dev/null
  source "$_har_node_pm_lib"
elif ! declare -F har_node_package_manager >/dev/null; then
  echo "provision-toolchain: node-pm helpers not found at $_har_node_pm_lib" >&2
  exit 1
fi

append_env() {
  local key="$1"
  local value="$2"
  # %q, not a raw value: an unquoted value with spaces (an Xcode scheme, a
  # simulator name, a path under /Applications) breaks `source .env.agent.<id>`.
  printf '%s=%q\n' "$key" "$value" >> "$HAR_ENV_FILE"
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
  local node_bin="node"
  local pkg_manager declared_manager
  declared_manager="$(har_node_declared_package_manager "$dir")"
  pkg_manager="$(har_node_package_manager "$dir")"

  if [ -n "$declared_manager" ] && [ "$declared_manager" != "$pkg_manager" ]; then
    pt_log "Repo declares ${declared_manager}, which is not on PATH — installing with ${pkg_manager} and leaving the lockfile untouched."
  fi

  if ! run_install_cmd "$dir"; then
    pt_log "Installing Node dependencies with ${pkg_manager}..."
    har_node_install "$dir" "$pkg_manager" "$declared_manager"
  fi

  if command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  elif [ "$pkg_manager" = "bun" ]; then
    # bun-only machine: bun runs the `node -e` snippets verify.sh relies on.
    node_bin="$(command -v bun)"
  fi

  local npm_bin="$pkg_manager"
  if command -v "$pkg_manager" >/dev/null 2>&1; then
    npm_bin="$(command -v "$pkg_manager")"
  fi

  append_env "HARNESS_ECOSYSTEM" "node"
  append_env "NODE_BIN" "$node_bin"
  append_env "NPM_BIN" "$npm_bin"
  append_env "HARNESS_NODE_PACKAGE_MANAGER" "$pkg_manager"
  append_env "HARNESS_PKG_EXEC" "$(har_pkg_exec "$pkg_manager")"
  append_path_prefix "$dir/node_modules/.bin"
}

# ── Python interpreter helpers ────────────────────────────────────────────────
# Resolve the project Python (requires-python, .python-version, uv) instead of
# blindly using PATH python3.

har_python_version_from_bin() {
  local bin="$1"
  "$bin" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null \
    | tr -d '[:space:]'
}

har_python_version_to_sortable() {
  local v="${1#python}"
  v="${v#v}"
  local major=0 minor=0 patch=0
  IFS='.' read -r major minor patch _ <<< "$v"
  major=${major:-0}
  minor=${minor:-0}
  patch=${patch:-0}
  printf '%03d%03d%03d' "$major" "$minor" "$patch"
}

har_python_version_ge() {
  local a b
  a="$(har_python_version_to_sortable "$1")"
  b="$(har_python_version_to_sortable "$2")"
  [ "$a" -ge "$b" ]
}

har_python_requires_minimum() {
  local spec="$1"
  local ver=""

  [ -n "$spec" ] || return 1

  ver="$(printf '%s' "$spec" | sed -n \
    -e 's/.*>=\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    -e 's/.*~=\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    -e 's/.*==\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    | head -1)"

  if [ -z "$ver" ]; then
    ver="$(printf '%s' "$spec" | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
  fi

  [ -n "$ver" ] && echo "$ver"
}

har_python_read_dot_version() {
  local dir="$1"
  [ -f "$dir/.python-version" ] || return 1
  head -1 "$dir/.python-version" | tr -d '[:space:]'
}

har_python_read_requires_spec() {
  local dir="$1"
  local spec=""

  if [ -f "$dir/pyproject.toml" ]; then
    spec="$(sed -n 's/^[[:space:]]*requires-python[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
      "$dir/pyproject.toml" | head -1)"
  fi
  if [ -z "$spec" ] && [ -f "$dir/setup.cfg" ]; then
    spec="$(sed -n '/^\[options\]/,/^\[/ s/^python_requires[[:space:]]*=[[:space:]]*\(.*\)/\1/p' \
      "$dir/setup.cfg" | head -1 | tr -d ' "')"
  fi
  [ -n "$spec" ] && echo "$spec"
}

har_python_project_minimum() {
  local dir="$1"
  local req_min="" dot_ver="" higher=""

  req_min="$(har_python_requires_minimum "$(har_python_read_requires_spec "$dir" || true)" || true)"
  dot_ver="$(har_python_read_dot_version "$dir" || true)"
  if [ -n "$dot_ver" ]; then
    dot_ver="$(printf '%s' "$dot_ver" | sed 's/^v//; s/^\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/')"
  fi

  if [ -n "$req_min" ] && [ -n "$dot_ver" ]; then
    if har_python_version_ge "$dot_ver" "$req_min"; then
      higher="$dot_ver"
    else
      higher="$req_min"
    fi
  elif [ -n "$req_min" ]; then
    higher="$req_min"
  elif [ -n "$dot_ver" ]; then
    higher="$dot_ver"
  fi

  [ -n "$higher" ] && echo "$higher"
}

har_python_is_uv_project() {
  local dir="$1"
  [ -f "$dir/uv.lock" ] && return 0
  [ -f "$dir/pyproject.toml" ] && grep -q '^\[tool\.uv\]' "$dir/pyproject.toml" 2>/dev/null
}

har_python_uv_find() {
  local dir="$1"
  local request="${2:-}"

  command -v uv >/dev/null 2>&1 || return 1
  if [ -n "$request" ]; then
    (cd "$dir" && uv python find "$request" 2>/dev/null)
  else
    (cd "$dir" && uv python find 2>/dev/null)
  fi
}

har_python_resolve_interpreter() {
  local dir="$1"
  local minimum="${2:-}"
  local found=""

  if har_python_is_uv_project "$dir"; then
    found="$(har_python_uv_find "$dir" "$minimum" || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then
      echo "$found"
      return 0
    fi
  fi

  if [ -f "$dir/.python-version" ]; then
    found="$(har_python_uv_find "$dir" "$(har_python_read_dot_version "$dir")" || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then
      echo "$found"
      return 0
    fi
    if command -v pyenv >/dev/null 2>&1; then
      found="$(cd "$dir" && pyenv which python 2>/dev/null || true)"
      if [ -n "$found" ] && [ -x "$found" ]; then
        echo "$found"
        return 0
      fi
    fi
  fi

  if [ -n "$minimum" ]; then
    found="$(har_python_uv_find "$dir" "$minimum" || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then
      echo "$found"
      return 0
    fi
  fi

  if command -v python3 >/dev/null 2>&1; then
    local sys_py sys_ver=""
    sys_py="$(command -v python3)"
    if [ -z "$minimum" ]; then
      echo "$sys_py"
      return 0
    fi
    sys_ver="$(har_python_version_from_bin "$sys_py")"
    if [ -n "$sys_ver" ] && har_python_version_ge "$sys_ver" "$minimum"; then
      echo "$sys_py"
      return 0
    fi
    echo "$sys_py"
    return 0
  fi

  return 1
}

har_python_warn_if_below_minimum() {
  local bin="$1"
  local minimum="$2"
  local actual=""

  [ -n "$minimum" ] || return 0
  actual="$(har_python_version_from_bin "$bin")"
  [ -n "$actual" ] || return 0
  if ! har_python_version_ge "$actual" "$minimum"; then
    pt_log "WARNING: resolved Python ${actual} is older than required ${minimum} (requires-python / .python-version)"
  fi
}

har_python_create_venv() {
  local dir="$1"
  local venv_dir="$2"
  local interpreter="$3"
  local venv_rel="${venv_dir#"$dir"/}"

  if har_python_is_uv_project "$dir" && command -v uv >/dev/null 2>&1; then
    pt_log "Creating Python venv with uv at ${venv_rel}..."
    if (cd "$dir" && uv venv --python "$interpreter" "$venv_dir" 2>/dev/null) \
      || (cd "$dir" && uv venv "$venv_dir" 2>/dev/null); then
      return 0
    fi
    pt_log "uv venv failed — falling back to ${interpreter} -m venv"
  fi

  pt_log "Creating Python venv at ${venv_rel}..."
  "$interpreter" -m venv "$venv_dir"
}

har_python_install_deps() {
  local dir="$1"
  local venv_dir="$2"

  if har_python_is_uv_project "$dir" && command -v uv >/dev/null 2>&1; then
    pt_log "Syncing Python dependencies with uv..."
    if (cd "$dir" && UV_PROJECT_ENVIRONMENT="$venv_dir" uv sync --quiet 2>/dev/null); then
      return 0
    fi
    if (cd "$dir" && uv sync --quiet 2>/dev/null); then
      return 0
    fi
    pt_log "uv sync failed — falling back to pip"
    return 1
  fi
  return 1
}

provision_python() {
  local dir="$1"
  local venv_rel="${HARNESS_PYTHON_VENV_DIR:-.har/venv}"
  local venv_dir="$dir/$venv_rel"
  local python_bin=""
  local interpreter=""
  local project_min=""

  project_min="$(har_python_project_minimum "$dir" || true)"
  interpreter="$(har_python_resolve_interpreter "$dir" "$project_min" || true)"

  if [ -z "$interpreter" ] || ! command -v "$interpreter" >/dev/null 2>&1; then
    pt_log "No suitable Python interpreter found — skipping venv provisioning"
    append_env "HARNESS_ECOSYSTEM" "python"
    append_env "PYTHON_BIN" "${PYTHON_BIN:-python3}"
    return
  fi

  if [ -n "$project_min" ]; then
    har_python_warn_if_below_minimum "$interpreter" "$project_min"
  fi

  if [ -d "$venv_dir" ] && [ -x "$venv_dir/bin/python" ] && [ -n "$project_min" ]; then
    local venv_ver=""
    venv_ver="$(har_python_version_from_bin "$venv_dir/bin/python")"
    if [ -n "$venv_ver" ] && ! har_python_version_ge "$venv_ver" "$project_min"; then
      pt_log "Existing venv Python ${venv_ver} is older than required ${project_min} — recreating..."
      rm -rf "$venv_dir"
    fi
  fi

  if [ ! -d "$venv_dir" ]; then
    if ! har_python_create_venv "$dir" "$venv_dir" "$interpreter"; then
      rm -rf "$venv_dir"
      pt_log "venv creation failed (on Debian/Ubuntu install python3-venv) — using resolved interpreter"
      append_env "HARNESS_ECOSYSTEM" "python"
      append_env "PYTHON_BIN" "$interpreter"
      return
    fi
  fi

  if [ ! -x "$venv_dir/bin/python" ]; then
    pt_log "Python venv at $venv_rel is missing or broken — using resolved interpreter"
    append_env "HARNESS_ECOSYSTEM" "python"
    append_env "PYTHON_BIN" "$interpreter"
    return
  fi

  python_bin="$venv_dir/bin/python"
  if [ -n "$project_min" ]; then
    har_python_warn_if_below_minimum "$python_bin" "$project_min"
  fi

  # shellcheck disable=SC1091
  source "$venv_dir/bin/activate"

  if ! run_install_cmd "$dir"; then
    if ! har_python_install_deps "$dir" "$venv_dir"; then
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

# ── iOS Xcode project helpers ─────────────────────────────────────────────────
# Tuist, XcodeGen and CocoaPods treat the .xcodeproj / .xcworkspace as a build
# product rather than a tracked file, so a fresh worktree has nothing for
# xcodebuild to open. Generate it here — and fail naming the missing generator,
# instead of letting xcodebuild report an opaque "scheme not found" later.

# First project file of a kind in the work dir. Runs from inside the dir so a dot
# in the worktree path itself cannot trip the dotfile filter, and skips both the
# project.xcworkspace every .xcodeproj carries inside it and whatever CocoaPods
# generates under Pods/.
har_ios_find_project_file() {
  local dir="$1"
  local pattern="$2"
  local match=""
  match="$(cd "$dir" 2>/dev/null && find . -maxdepth 2 -name "$pattern" \
    ! -path "./.*" ! -path "*.xcodeproj/*" ! -path "*/Pods/*" 2>/dev/null | head -1)" || true
  [ -n "$match" ] || return 1
  echo "${match#./}"
}

# True when this worktree already has something xcodebuild can open. Adapt-time
# HARNESS_XCODE_WORKSPACE / HARNESS_XCODE_PROJECT decide it when set: they name
# the generated file, so a missing one means the generator still has to run.
har_ios_has_project() {
  local dir="$1"

  if [ -n "${HARNESS_XCODE_WORKSPACE:-}" ] || [ -n "${HARNESS_XCODE_PROJECT:-}" ]; then
    if [ -n "${HARNESS_XCODE_WORKSPACE:-}" ] && [ -e "$dir/$HARNESS_XCODE_WORKSPACE" ]; then
      return 0
    fi
    if [ -n "${HARNESS_XCODE_PROJECT:-}" ] && [ -e "$dir/$HARNESS_XCODE_PROJECT" ]; then
      return 0
    fi
    return 1
  fi

  if har_ios_find_project_file "$dir" '*.xcworkspace' >/dev/null; then return 0; fi
  if har_ios_find_project_file "$dir" '*.xcodeproj' >/dev/null; then return 0; fi
  return 1
}

# Generator this repo declares, or empty. A Podfile counts: `pod install` is what
# writes the .xcworkspace for a CocoaPods project.
har_ios_project_generator() {
  local dir="$1"
  if [ -f "$dir/Project.swift" ] || [ -f "$dir/Workspace.swift" ]; then echo tuist; return; fi
  if [ -f "$dir/project.yml" ] || [ -f "$dir/project.yaml" ]; then echo xcodegen; return; fi
  if [ -f "$dir/Podfile" ]; then echo pod; return; fi
  echo ""
}

har_ios_generate_project() {
  local dir="$1"
  local generator=""

  if har_ios_has_project "$dir"; then
    return 0
  fi

  generator="$(har_ios_project_generator "$dir")"
  if [ -z "$generator" ]; then
    pt_log "No .xcodeproj/.xcworkspace found and no generator manifest (Project.swift, project.yml, Podfile) — set HARNESS_XCODE_PROJECT/HARNESS_XCODE_WORKSPACE or HARNESS_INSTALL_CMD in harness.env"
    return 0
  fi

  if ! command -v "$generator" >/dev/null 2>&1; then
    local label="$generator"
    [ "$generator" = "pod" ] && label="CocoaPods (pod)"
    pt_log "ERROR: this repo generates its Xcode project with ${label}, which is not on PATH."
    pt_log "       Install ${label}, or set HARNESS_INSTALL_CMD in harness.env to provision the project another way."
    return 1
  fi

  case "$generator" in
    tuist)
      pt_log "Generating the Xcode project with tuist..."
      if ! (cd "$dir" && tuist generate --no-open); then
        pt_log "tuist generate --no-open failed — retrying without the flag"
        (cd "$dir" && tuist generate)
      fi
      ;;
    xcodegen)
      pt_log "Generating the Xcode project with xcodegen..."
      (cd "$dir" && xcodegen generate)
      ;;
    pod)
      # har_ios_pod_install writes the workspace right after this.
      :
      ;;
  esac
}

# CocoaPods dependencies. Independent of project generation: a tracked
# .xcworkspace still cannot build when Pods/ is missing in a fresh worktree.
har_ios_pod_install() {
  local dir="$1"

  [ -f "$dir/Podfile" ] || return 0
  [ -d "$dir/Pods" ] && return 0

  if ! command -v pod >/dev/null 2>&1; then
    pt_log "ERROR: this repo uses CocoaPods (Podfile, no Pods/) and pod is not on PATH."
    pt_log "       Install CocoaPods, or set HARNESS_INSTALL_CMD in harness.env to provision the project another way."
    return 1
  fi

  pt_log "Installing CocoaPods dependencies..."
  (cd "$dir" && pod install)
}

provision_ios() {
  local dir="$1"

  # An explicit HARNESS_INSTALL_CMD owns provisioning outright: the default
  # generators stay out of the way, and a failing override fails the launch
  # rather than being papered over.
  if [ -n "${HARNESS_INSTALL_CMD:-}" ]; then
    run_install_cmd "$dir"
  else
    har_ios_generate_project "$dir"
    har_ios_pod_install "$dir"
  fi

  append_env "HARNESS_ECOSYSTEM" "ios"
  append_env "XCODEBUILD_BIN" "$(command -v xcodebuild 2>/dev/null || echo xcodebuild)"
  if [ -n "${HARNESS_XCODE_SCHEME:-}" ]; then
    append_env "HARNESS_XCODE_SCHEME" "$HARNESS_XCODE_SCHEME"
  fi
  # The simulator is not recorded here: launch.sh writes the device reserved for
  # this slot, and harness.env already carries the shared one.
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
  local pkg_manager
  pkg_manager="$(har_node_package_manager "$HAR_WORKTREE_DIR")"
  pt_log "Installing monorepo root dependencies in $HAR_WORKTREE_DIR with ${pkg_manager}..."
  har_node_install "$HAR_WORKTREE_DIR" "$pkg_manager" \
    "$(har_node_declared_package_manager "$HAR_WORKTREE_DIR")"
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

# Node package-manager helpers — the single source of truth for how HAR
# resolves, installs with, and execs through the repo's package manager.
# Sourced by agent-slot.sh (for every .har script) and by
# provision-toolchain.sh (the provisioning subprocess), so a sourcing script
# and the subprocess always resolve the same tool.


# Package managers HAR can drive, in fallback preference order.
HAR_NODE_PACKAGE_MANAGERS="npm bun pnpm yarn"

# Package manager the repo declares: an explicit HARNESS_NODE_PACKAGE_MANAGER
# wins, then package.json "packageManager", then the lockfile. Empty when the
# repo says nothing.
har_node_declared_package_manager() {
  local dir="${1:-.}"

  if [ -n "${HARNESS_NODE_PACKAGE_MANAGER:-}" ]; then
    echo "$HARNESS_NODE_PACKAGE_MANAGER"
    return
  fi
  if [ -f "$dir/package.json" ]; then
    local field
    field="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"\([a-z]*\)@.*/\1/p' "$dir/package.json" | head -1)"
    if [ -n "$field" ]; then
      echo "$field"
      return
    fi
  fi
  if [ -f "$dir/bun.lock" ] || [ -f "$dir/bun.lockb" ]; then echo bun; return; fi
  if [ -f "$dir/pnpm-lock.yaml" ]; then echo pnpm; return; fi
  if [ -f "$dir/yarn.lock" ]; then echo yarn; return; fi
  if [ -f "$dir/package-lock.json" ]; then echo npm; return; fi
  echo ""
}

# Package manager to actually run. A manager the repo declares but this machine
# lacks falls back to one that is installed, so a repo pinned to npm still
# provisions on a bun-only machine (and the reverse).
har_node_package_manager() {
  local dir="${1:-.}"
  local declared
  declared="$(har_node_declared_package_manager "$dir")"

  if [ -n "$declared" ] && command -v "$declared" >/dev/null 2>&1; then
    echo "$declared"
    return
  fi

  local candidate
  for candidate in $HAR_NODE_PACKAGE_MANAGERS; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done

  echo "${declared:-npm}"
}

# Lockfile a manager writes, so a substitute install can clean up after itself.
har_node_lockfile() {
  case "$1" in
    bun) echo "bun.lock" ;;
    npm) echo "package-lock.json" ;;
    pnpm) echo "pnpm-lock.yaml" ;;
    yarn) echo "yarn.lock" ;;
    *) echo "" ;;
  esac
}

# Install dependencies in a directory. When a substitute manager stands in for
# the one the repo declares, any lockfile it creates is removed afterwards:
# provisioning must not migrate the repo to a different package manager.
# (bun writes bun.lock even under --no-save, so the flags alone are not enough.)
har_node_install() {
  local dir="$1"
  local manager="$2"
  local declared="${3:-}"
  local substituting=false
  local lockfile=""
  local had_lockfile=false

  if [ -n "$declared" ] && [ "$declared" != "$manager" ]; then
    substituting=true
    lockfile="$(har_node_lockfile "$manager")"
    if [ -n "$lockfile" ] && [ -e "$dir/$lockfile" ]; then
      had_lockfile=true
    fi
  fi

  local code=0
  (cd "$dir" && "$manager" install --silent) || code=$?

  if [ "$substituting" = true ] && [ "$had_lockfile" = false ] && [ -n "$lockfile" ]; then
    rm -f "$dir/$lockfile"
    [ "$manager" = "bun" ] && rm -f "$dir/bun.lockb"
  fi
  return $code
}

# Package runner (npx equivalent) for one-off CLIs such as pm2, including the
# flag that keeps it non-interactive. Takes a manager name, or none to resolve
# from the environment and PATH.
har_pkg_exec() {
  case "${1:-${HARNESS_NODE_PACKAGE_MANAGER:-}}" in
    bun) echo "bunx"; return ;;
    pnpm) echo "pnpm dlx"; return ;;
    yarn) echo "yarn dlx"; return ;;
    npm) echo "npx --yes"; return ;;
  esac
  if command -v npx >/dev/null 2>&1; then echo "npx --yes"; return; fi
  if command -v bunx >/dev/null 2>&1; then echo "bunx"; return; fi
  if command -v pnpm >/dev/null 2>&1; then echo "pnpm dlx"; return; fi
  echo "npx --yes"
}

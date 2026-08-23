# Shared infra helpers — the single source of truth for infra-service checks,
# the Postgres client wrapper, and infra port-lane resolution.
# Sourced by agent-slot.sh so every .har script gets the same behavior.
# harness.env stays pure KEY=value config; runtime code lives here.


# Returns 0 when a shared infra service is enabled: har_infra_enabled db
har_infra_enabled() {
  case " ${HARNESS_INFRA_SERVICES:-} " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Postgres client — uses host tools when installed, otherwise docker exec into
# the shared db container. Usage: har_pg psql -d postgres -c "SELECT 1"
#                                 har_pg createdb -T template_x agent_1
har_pg() {
  local tool="$1"; shift
  if command -v "$tool" >/dev/null 2>&1; then
    PGPASSWORD=password "$tool" -h localhost -p "${AGENT_DB_PORT:-$(har_infra_port_default db 15432)}" -U postgres "$@"
  else
    docker exec -i -e PGPASSWORD=password "har-${HARNESS_PROJECT_NAME}-db-1" "$tool" -U postgres "$@"
  fi
}

# Infra port lanes are declared once in harness.env as pure data:
#   HARNESS_INFRA_PORT_LANES="db=15432:15432-15499 minio=19000:19000-19099 ..."
# Each entry is <lane>=<default>:<scan_start>-<scan_end>. Legacy per-lane
# HARNESS_<LANE>_PORT_DEFAULT/_SCAN_START/_SCAN_END triplets are still honored
# as a fallback for pre-1.0 harnesses.

# Echoes "<default> <scan_start> <scan_end>" for a lane; returns 1 when the
# lane is not declared anywhere. Usage: har_infra_port_lane db
har_infra_port_lane() {
  local lane="$1" entry spec range
  for entry in ${HARNESS_INFRA_PORT_LANES:-}; do
    case "$entry" in
      "$lane="*)
        spec="${entry#*=}"
        case "$spec" in
          *:*-*) ;;
          *)
            echo "Error: malformed HARNESS_INFRA_PORT_LANES entry '$entry' (expected <lane>=<default>:<start>-<end>)" >&2
            return 1 ;;
        esac
        range="${spec#*:}"
        echo "${spec%%:*} ${range%-*} ${range#*-}"
        return 0 ;;
    esac
  done

  # Legacy triplet fallback: db → HARNESS_DB_PORT_*, mailpit-web → HARNESS_MAILPIT_WEB_PORT_*
  local prefix d_var s_var e_var
  prefix="HARNESS_$(echo "$lane" | tr '[:lower:]-' '[:upper:]_')_PORT"
  d_var="${prefix}_DEFAULT" s_var="${prefix}_SCAN_START" e_var="${prefix}_SCAN_END"
  if [ -n "${!d_var:-}" ]; then
    echo "${!d_var} ${!s_var:-${!d_var}} ${!e_var:-${!d_var}}"
    return 0
  fi
  return 1
}

# Echoes the lane's default port, or the given fallback when the lane is not
# declared. Usage: har_infra_port_default db 15432
har_infra_port_default() {
  local lane_info
  if lane_info="$(har_infra_port_lane "$1" 2>/dev/null)"; then
    echo "${lane_info%% *}"
  else
    echo "$2"
  fi
}

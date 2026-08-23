#!/usr/bin/env bash
# Sets up shared infrastructure for all agents.
# Starts the docker compose services listed in HARNESS_INFRA_SERVICES, creates
# the template database (when "db" is enabled), and starts optional shared app
# services (ecosystem.shared.config.cjs). One instance serves every agent slot.
# Idempotent — safe to run multiple times.
#
# Usage: ./.har/setup-infra.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.agent.yml"
INFRA_STATE="$SCRIPT_DIR/state/infra.env"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/agent-slot.sh"

COMPOSE_PROJECT="har-${HARNESS_PROJECT_NAME}"
PSQL="har_pg psql -d postgres"

log() { echo "==> $*" >&2; }

har_compose_service_running() {
  local service="$1"
  docker ps --filter "name=${COMPOSE_PROJECT}-${service}-1" --format '{{.Names}}' 2>/dev/null \
    | grep -q "^${COMPOSE_PROJECT}-${service}-1\$"
}

# Resolve a shared-infra host port from its lane declared in harness.env
# (HARNESS_INFRA_PORT_LANES, via har_infra_port_lane from lib/infra.sh).
# Usage: har_resolve_infra_port <persisted_var> <lane> <fallback_default> [compose_service]
har_resolve_infra_port() {
  local var_name="$1"
  local lane="$2"
  local fallback_default="$3"
  local service="${4:-}"
  local current="${!var_name:-}"

  if [ -n "$current" ] && { ! port_in_use "$current" || { [ -n "$service" ] && har_compose_service_running "$service"; }; }; then
    echo "$current"
    return 0
  fi

  local lane_info default_port scan_start scan_end
  if lane_info="$(har_infra_port_lane "$lane")"; then
    read -r default_port scan_start scan_end <<<"$lane_info"
  else
    default_port="$fallback_default"
    scan_start="$fallback_default"
    scan_end="$fallback_default"
  fi
  har_allocate_port "$default_port" "$scan_start" "$scan_end"
}

mkdir -p "$(dirname "$INFRA_STATE")"
if [ -f "$INFRA_STATE" ]; then
  # shellcheck source=/dev/null
  source "$INFRA_STATE"
fi

DB_PORT="$(har_resolve_infra_port AGENT_DB_PORT db 15432 \
  db)"
MINIO_PORT="$(har_resolve_infra_port AGENT_MINIO_PORT minio 19000 \
  minio)"
MINIO_CONSOLE_PORT="$(har_resolve_infra_port AGENT_MINIO_CONSOLE_PORT minio-console 19050)"
BROWSER_PORT="$(har_resolve_infra_port AGENT_BROWSER_PORT browser 13001 \
  headless-browser)"
MAILPIT_WEB_PORT="$(har_resolve_infra_port AGENT_MAILPIT_WEB_PORT mailpit-web 18025 \
  mailpit)"
MAILPIT_SMTP_PORT="$(har_resolve_infra_port AGENT_MAILPIT_SMTP_PORT mailpit-smtp 11025)"

export AGENT_DB_PORT="$DB_PORT"
export AGENT_MINIO_PORT="$MINIO_PORT"
export AGENT_MINIO_CONSOLE_PORT="$MINIO_CONSOLE_PORT"
export AGENT_BROWSER_PORT="$BROWSER_PORT"
export AGENT_MAILPIT_WEB_PORT="$MAILPIT_WEB_PORT"
export AGENT_MAILPIT_SMTP_PORT="$MAILPIT_SMTP_PORT"

cat > "$INFRA_STATE" <<EOF
# Persisted by setup-infra.sh — host ports for shared docker compose services.
export AGENT_DB_PORT=${DB_PORT}
export AGENT_MINIO_PORT=${MINIO_PORT}
export AGENT_MINIO_CONSOLE_PORT=${MINIO_CONSOLE_PORT}
export AGENT_BROWSER_PORT=${BROWSER_PORT}
export AGENT_MAILPIT_WEB_PORT=${MAILPIT_WEB_PORT}
export AGENT_MAILPIT_SMTP_PORT=${MAILPIT_SMTP_PORT}
EOF

SERVICES="${HARNESS_INFRA_SERVICES:-}"

if [ -n "$SERVICES" ]; then
  log "Starting shared infrastructure (project: $COMPOSE_PROJECT): $SERVICES"
  AGENT_DB_PORT="$DB_PORT" \
  AGENT_MINIO_PORT="$MINIO_PORT" \
  AGENT_MINIO_CONSOLE_PORT="$MINIO_CONSOLE_PORT" \
  AGENT_BROWSER_PORT="$BROWSER_PORT" \
  AGENT_MAILPIT_WEB_PORT="$MAILPIT_WEB_PORT" \
  AGENT_MAILPIT_SMTP_PORT="$MAILPIT_SMTP_PORT" \
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d $SERVICES
else
  log "No shared infra services enabled in harness.env (HARNESS_INFRA_SERVICES)"
fi

# Wait for PostgreSQL and prepare the template database
if har_infra_enabled db; then
  log "Waiting for PostgreSQL on port $DB_PORT..."
  for i in $(seq 1 30); do
    if har_pg pg_isready -q 2>/dev/null; then
      log "PostgreSQL is ready."
      break
    fi
    if [ "$i" = "30" ]; then
      echo "Error: PostgreSQL did not become ready within 30 seconds." >&2
      exit 1
    fi
    sleep 1
  done

  log "Enabling pg_stat_statements extension..."
  $PSQL -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" 2>/dev/null || true

  if [ -n "${HARNESS_TEMPLATE_DB:-}" ]; then
    if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname = '$HARNESS_TEMPLATE_DB'" | grep -q 1; then
      log "Template database '$HARNESS_TEMPLATE_DB' already exists. Skipping creation."
    else
      log "Creating template database '$HARNESS_TEMPLATE_DB'..."
      $PSQL -c "CREATE DATABASE $HARNESS_TEMPLATE_DB"

      if [ -n "${HARNESS_DB_MIGRATE_CMD:-}" ]; then
        log "Running migrations..."
        PGPASSWORD=password PGHOST=localhost PGPORT="$DB_PORT" PGUSER=postgres \
          PGDATABASE="$HARNESS_TEMPLATE_DB" \
          bash -c "cd '$REPO_ROOT' && $HARNESS_DB_MIGRATE_CMD"
      fi

      if [ -n "${HARNESS_DB_SEED_CMD:-}" ]; then
        log "Running seeds..."
        PGPASSWORD=password PGHOST=localhost PGPORT="$DB_PORT" PGUSER=postgres \
          PGDATABASE="$HARNESS_TEMPLATE_DB" \
          bash -c "cd '$REPO_ROOT' && $HARNESS_DB_SEED_CMD"
      fi

      log "Marking '$HARNESS_TEMPLATE_DB' as a PostgreSQL template..."
      $PSQL -c "UPDATE pg_database SET datistemplate = true WHERE datname = '$HARNESS_TEMPLATE_DB'"
      log "Template database ready: $HARNESS_TEMPLATE_DB"
    fi
  fi
fi

# Shared app services — supporting services of a monolith/monorepo that agents
# depend on but do not modify. Started ONCE on fixed ports, shared by all slots.
# Create .har/ecosystem.shared.config.cjs (PM2 format, processes named
# "har-${HARNESS_PROJECT_NAME}-shared-<name>") only when the primary app needs
# sibling services running.
SHARED_ECOSYSTEM="$SCRIPT_DIR/ecosystem.shared.config.cjs"
if [ -f "$SHARED_ECOSYSTEM" ]; then
  log "Starting shared app services from ecosystem.shared.config.cjs..."
  (cd "$REPO_ROOT" && $(har_pkg_exec) pm2 startOrReload "$SHARED_ECOSYSTEM" >/dev/null)
  log "Shared app services running (pm2 ls | grep har-${HARNESS_PROJECT_NAME}-shared-)."
fi

echo ""
log "Infrastructure is ready."
har_infra_enabled db               && log "  PostgreSQL: localhost:$DB_PORT"
har_infra_enabled minio            && log "  MinIO:      http://localhost:${MINIO_CONSOLE_PORT}"
har_infra_enabled headless-browser && log "  Browser:    http://localhost:${BROWSER_PORT}"
har_infra_enabled mailpit          && log "  Mailpit:    http://localhost:${MAILPIT_WEB_PORT}"
exit 0

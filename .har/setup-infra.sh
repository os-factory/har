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

# shellcheck source=/dev/null
source "$SCRIPT_DIR/harness.env"

COMPOSE_PROJECT="har-${HARNESS_PROJECT_NAME}"
DB_PORT="${AGENT_DB_PORT:-15432}"
PSQL="har_pg psql -d postgres"

log() { echo "==> $*" >&2; }

SERVICES="${HARNESS_INFRA_SERVICES:-}"

if [ -n "$SERVICES" ]; then
  log "Starting shared infrastructure (project: $COMPOSE_PROJECT): $SERVICES"
  AGENT_DB_PORT="$DB_PORT" \
  AGENT_MINIO_PORT="${AGENT_MINIO_PORT:-19000}" \
  AGENT_MINIO_CONSOLE_PORT="${AGENT_MINIO_CONSOLE_PORT:-19001}" \
  AGENT_BROWSER_PORT="${AGENT_BROWSER_PORT:-13001}" \
  AGENT_MAILPIT_WEB_PORT="${AGENT_MAILPIT_WEB_PORT:-18025}" \
  AGENT_MAILPIT_SMTP_PORT="${AGENT_MAILPIT_SMTP_PORT:-11025}" \
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

      if [ -n "${HARNESS_DB_MIGRATE_CMD:-}" ] && [ "$HARNESS_DB_MIGRATE_CMD" != "echo 'TODO: set migrate command'" ]; then
        log "Running migrations..."
        PGPASSWORD=password PGHOST=localhost PGPORT="$DB_PORT" PGUSER=postgres \
          PGDATABASE="$HARNESS_TEMPLATE_DB" \
          bash -c "cd '$REPO_ROOT' && $HARNESS_DB_MIGRATE_CMD"
      fi

      if [ -n "${HARNESS_DB_SEED_CMD:-}" ] && [ "$HARNESS_DB_SEED_CMD" != "echo 'TODO: set seed command'" ]; then
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
SHARED_ECOSYSTEM="$SCRIPT_DIR/ecosystem.shared.config.cjs"
if [ -f "$SHARED_ECOSYSTEM" ]; then
  log "Starting shared app services from ecosystem.shared.config.cjs..."
  (cd "$REPO_ROOT" && npx --yes pm2 startOrReload "$SHARED_ECOSYSTEM" >/dev/null)
  log "Shared app services running (pm2 ls | grep har-shared-)."
fi

echo ""
log "Infrastructure is ready."
har_infra_enabled db               && log "  PostgreSQL: localhost:$DB_PORT"
har_infra_enabled minio            && log "  MinIO:      http://localhost:${AGENT_MINIO_CONSOLE_PORT:-19001}"
har_infra_enabled headless-browser && log "  Browser:    http://localhost:${AGENT_BROWSER_PORT:-13001}"
har_infra_enabled mailpit          && log "  Mailpit:    http://localhost:${AGENT_MAILPIT_WEB_PORT:-18025}"
exit 0

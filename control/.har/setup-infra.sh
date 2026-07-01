#!/usr/bin/env bash
# Sets up shared infrastructure for all agents.
# Starts Docker Compose stack and creates the template database.
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
PSQL="psql -h localhost -p $DB_PORT -U postgres -d postgres"

log() { echo "==> $*" >&2; }

# Determine which services to start
SERVICES=""
[ "$HARNESS_INFRA_POSTGRES" = "true" ]   && SERVICES="db"
[ "$HARNESS_INFRA_MINIO" = "true" ]     && SERVICES="${SERVICES} minio"
[ "$HARNESS_INFRA_BROWSER" = "true" ]   && SERVICES="${SERVICES} headless-browser"
[ "$HARNESS_INFRA_MAILPIT" = "true" ]   && SERVICES="${SERVICES} mailpit"

if [ -z "$SERVICES" ]; then
  log "No infrastructure services enabled in harness.env"
  exit 0
fi

log "Starting shared infrastructure (project: $COMPOSE_PROJECT)..."
AGENT_DB_PORT="$DB_PORT" \
AGENT_MINIO_PORT=19000 \
AGENT_MINIO_CONSOLE_PORT=19001 \
AGENT_BROWSER_PORT=13001 \
AGENT_MAILPIT_WEB_PORT=18025 \
AGENT_MAILPIT_SMTP_PORT=11025 \
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d $SERVICES

# Wait for PostgreSQL
if [ "$HARNESS_INFRA_POSTGRES" = "true" ]; then
  log "Waiting for PostgreSQL on port $DB_PORT..."
  for i in $(seq 1 30); do
    if PGPASSWORD=password pg_isready -h localhost -p "$DB_PORT" -U postgres -q 2>/dev/null; then
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

echo ""
log "Infrastructure is ready."
[ "$HARNESS_INFRA_POSTGRES" = "true" ]   && log "  PostgreSQL: localhost:$DB_PORT"
[ "$HARNESS_INFRA_MINIO" = "true" ]     && log "  MinIO:      http://localhost:19001"
[ "$HARNESS_INFRA_BROWSER" = "true" ]   && log "  Browser:    http://localhost:13001"
[ "$HARNESS_INFRA_MAILPIT" = "true" ]   && log "  Mailpit:    http://localhost:18025"

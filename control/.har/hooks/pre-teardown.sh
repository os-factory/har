#!/usr/bin/env bash
# Remove the slot's embedded SQLite database before the slot is torn down.
# In worktree mode the file lives inside the worktree (removed with it); this
# also covers --no-worktree runs. Lifted from the pre-1.0 adapted teardown.sh
# (1.0 migration, #242).
set -euo pipefail

for db_dir in "${WORK_DIR:-}" "$(cd "${HAR_HARNESS_DIR:?}/.." && pwd)"; do
  [ -n "$db_dir" ] || continue
  db_file="${db_dir%/}/prisma/agent_${AGENT_ID:?}.db"
  if [ -f "$db_file" ]; then
    rm -f "$db_file" "${db_file}-journal" "${db_file}-wal" "${db_file}-shm"
    echo "✓ Removed database: $db_file"
  fi
done

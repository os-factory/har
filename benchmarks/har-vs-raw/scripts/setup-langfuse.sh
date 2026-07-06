#!/usr/bin/env bash
# Start Langfuse locally for the HAR vs raw benchmark.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANGFUSE_DIR="${LANGFUSE_DIR:-$HOME/dev/langfuse}"
LANGFUSE_PORT="${LANGFUSE_PORT:-3300}"

if [[ ! -d "$LANGFUSE_DIR" ]]; then
  echo "Cloning Langfuse into $LANGFUSE_DIR"
  git clone --depth=1 https://github.com/langfuse/langfuse.git "$LANGFUSE_DIR"
fi

cd "$LANGFUSE_DIR"

if ! grep -q "127.0.0.1:${LANGFUSE_PORT}:3000" docker-compose.yml 2>/dev/null; then
  echo "Reminder: map langfuse-web to 127.0.0.1:${LANGFUSE_PORT}:3000 if benchmark apps also use :3000"
fi

echo "Starting Langfuse (UI expected at http://localhost:${LANGFUSE_PORT})"
docker compose up -d

cat > "$ROOT/.env.local.example" <<EOF
# Copy to .env.local and fill in project keys from Langfuse UI -> Settings -> API Keys
LANGFUSE_HOST=http://localhost:${LANGFUSE_PORT}
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...

# Optional: higher GitHub API rate limits for issue curation
# GITHUB_TOKEN=ghp_...

# Optional: explicit Claude Code telemetry target (defaults to LANGFUSE_HOST)
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${LANGFUSE_PORT}/api/public/otel
EOF

echo "Created $ROOT/.env.local.example"
echo "Open http://localhost:${LANGFUSE_PORT} and create a project + API keys."

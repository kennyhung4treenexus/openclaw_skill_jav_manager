#!/bin/bash
# Post-pipeline FlareSolverr container cleanup
# Recreates all 3 FlareSolverr containers to clear accumulated Chrome cache
set -e

echo "[post-pipeline] Recreating FlareSolverr containers..."

RECREATE=(
  "flaresolverr:8191"
  "flaresolverr-2:8192"
  "flaresolverr-3:8193"
)

for entry in "${RECREATE[@]}"; do
  name="${entry%%:*}"
  port="${entry##*:}"

  echo "[post-pipeline] Stopping $name..."
  docker stop "$name" 2>/dev/null || true

  echo "[post-pipeline] Removing $name..."
  docker rm "$name" 2>/dev/null || true

  echo "[post-pipeline] Starting $name on host port $port..."
  docker run -d \
    --name "$name" \
    --restart unless-stopped \
    -p "${port}:8191" \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    ghcr.io/flaresolverr/flaresolverr:latest
done

echo "[post-pipeline] All FlareSolverr containers recreated."

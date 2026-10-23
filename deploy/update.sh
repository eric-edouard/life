#!/usr/bin/env bash
# Deploys main: pulls it and rebuilds what changed (docs/use/server.md). No CI, no registry: the box builds.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
git -C "$REPO" pull --ff-only origin main
docker compose -f "$REPO/deploy/compose.yaml" up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose -f "$REPO/deploy/compose.yaml" ps

#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-api}"
shift || true

case "$cmd" in
  api)
    cd /app/apps/api
    exec bun run src/server.ts
    ;;
  worker)
    cd /app/apps/worker
    exec bun run src/worker.ts
    ;;
  migrate)
    cd /app/packages/db
    exec bunx prisma migrate deploy "$@"
    ;;
  bootstrap)
    cd /app/packages/db
    exec bun run src/bootstrap.ts "$@"
    ;;
  *)
    echo "usage: $0 api | worker | migrate | bootstrap [...]" >&2
    exit 1
    ;;
esac

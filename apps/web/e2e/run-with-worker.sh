#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/apps/worker"
bun run src/worker.ts &
W=$!
trap 'kill "$W" 2>/dev/null || true' EXIT
sleep 2
cd "$ROOT/apps/web"
exec playwright test "$@"

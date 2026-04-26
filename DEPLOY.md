# Deploying Queuehouse

Queuehouse ships as a **single OCI image** (`Dockerfile`) that can run the HTTP API, the BullMQ worker, or one-off database operations. Runtime dependencies are **PostgreSQL** and **Redis**.

## Image commands

The container entrypoint accepts the first argument as the process mode:

| Command | Purpose |
| --- | --- |
| `api` (default) | `bun` serves the Hono API (`apps/api`). |
| `worker` | Runs BullMQ workers (`apps/worker`). |
| `migrate` | Runs `prisma migrate deploy` in `packages/db` (requires `DATABASE_URL`). |
| `bootstrap` | Creates the first admin user when the `User` table is empty (requires `DATABASE_URL` and credentials; see below). |

Examples:

```bash
docker build -t queuehouse .

docker run --rm -e DATABASE_URL -e REDIS_URL -e SESSION_SECRET -p 3000:3000 queuehouse api

docker run --rm -e DATABASE_URL -e REDIS_URL queuehouse worker

docker run --rm -e DATABASE_URL queuehouse migrate

docker run --rm -e DATABASE_URL \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD='use-a-long-secret' \
  queuehouse bootstrap
```

**Migrations and bootstrap do not run on API startup.** Apply schema changes with `migrate` before (or alongside) rolling out a new version. Use `bootstrap` once per environment when no users exist.

## Compose layouts

| File | Intent |
| --- | --- |
| `compose.yaml` | Production-like: API + worker + Postgres + Redis, `NODE_ENV=production`, healthchecks on all app services. |
| `compose.dev.yaml` | Postgres + Redis only; run API/worker/web on the host with local `bun` (matches typical development). |
| `compose.test.yaml` | Postgres (`5433`) + Redis (`6380`) for host-run tests without clashing with dev ports. |

First-time stack (production-like):

```bash
docker compose up -d postgres redis
docker compose run --rm api migrate
docker compose run --rm api bootstrap -- --email you@example.com --password '…'
docker compose up -d
```

Replace `SESSION_SECRET` and database credentials in `compose.yaml` (or override with a Compose `env_file`) before a real deployment.

## Health checks

| Target | Check |
| --- | --- |
| API liveness | `GET /healthz` — process up; includes `version` and `namespace`. |
| API readiness | `GET /readyz` — PostgreSQL and Redis reachable using current env (returns 503 until dependencies accept connections). |
| Worker | `bun run src/healthcheck.ts` in `apps/worker` — Redis ping with timeout (used by Compose `healthcheck`). |

Orchestrators should treat `/healthz` as liveness and `/readyz` as readiness for the API. Workers have no HTTP port; use the Redis ping healthcheck or process supervision.

## Environment variables

Loaded via `loadConfig` in `@queuehouse/core` (API uses stricter production rules).

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | API yes; migrate/bootstrap yes; worker optional | PostgreSQL connection string. |
| `REDIS_URL` | API and worker | Redis for BullMQ and worker heartbeats. |
| `SESSION_SECRET` | API in `NODE_ENV=production` | Min 32 characters; known weak values are rejected. |
| `NODE_ENV` | Recommended | `development` \| `test` \| `production`. |
| `PORT` | Optional | API listen port (default `3000`). |
| `APP_NAMESPACE` or `QUEUEHOUSE_NAMESPACE` | Optional | Logical namespace / Bull key prefix (default `queuehouse`). |
| `CORS_ORIGIN` | Production browser access | Comma-separated allowed origins (dev defaults to local Vite). |
| `WORKER_SHUTDOWN_GRACE_MS` | Optional | Worker SIGTERM grace (default 30s, max 1h). |
| `WORKER_METRICS_PORT` | Optional | When set (1–65535), worker serves `GET /metrics` (Prometheus) on this port. Scrape alongside the API `/metrics` (different process). Restrict at the network layer in production. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | bootstrap only | Alternative to CLI flags for `bootstrap`. |

## Production guards

When `NODE_ENV=production`, the API config rejects:

- `DATABASE_URL` equal to the documented local example URL (`…queuehouse:queuehouse@localhost:5432/queuehouse`).
- Missing, short, or known-weak `SESSION_SECRET`.

Run workers with `NODE_ENV=production` only when satisfied with Redis/network security; workers do not require `SESSION_SECRET`.

## Secrets

- Generate `SESSION_SECRET` with a CSPRNG (e.g. `openssl rand -hex 32`).
- Prefer managed secrets (Kubernetes secrets, ECS task secrets, etc.) over committing `.env`.
- Database and Redis credentials should be unique per environment; restrict network access to those services.

## Operations checklist

1. Start PostgreSQL and Redis.
2. `migrate` with the target `DATABASE_URL`.
3. `bootstrap` if there are zero users.
4. Run at least one `api` instance and one `worker` instance (scale workers horizontally as needed).
5. Point a reverse proxy at the API; enforce TLS at the edge.
6. Configure `CORS_ORIGIN` for browser clients.

The operator UI (`apps/web`) is not included in this image; build and host it separately (static assets + `VITE_…` API base URL) or extend the image if you need a combined asset container.

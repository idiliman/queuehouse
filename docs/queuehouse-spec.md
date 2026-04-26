# Queuehouse Architecture Spec

## Product Goal

Queuehouse is a deploy-anywhere queue service for Bun. It provides a typed job API, a React admin UI, managed failed-job/DLQ workflows, cron and delayed scheduling, manual retry, auditability, and production-grade operational visibility.

The system is optimized for internal/admin operations first, while still exposing a type-safe external enqueue API backed by Zod and OpenAPI.

## Core Decisions

- Runtime: Bun.
- API framework: Hono.
- API schema/docs: Zod with `@hono/zod-openapi`, served through Scalar.
- Queue engine: BullMQ with Redis.
- App metadata database: Postgres.
- ORM: Prisma.
- UI: React, Vite, shadcn/ui, Tailwind CSS.
- Monorepo: Turborepo.
- Deployment: Docker, with one reusable production image and separate API/worker commands.
- Job definitions: statically registered in code.
- Scheduling: supports delayed jobs and cron/recurring jobs in v1.
- DLQ model: managed DLQ abstraction backed by BullMQ failed jobs.

## Repository Layout

```txt
apps/
  api/
    src/
      server.ts
      routes/
      middleware/
      openapi/
      static.ts
  worker/
    src/
      worker.ts
      shutdown.ts
      heartbeat.ts
  web/
    src/
      app/
      components/
      routes/
      lib/api-client/
packages/
  core/
    src/
      framework/
      jobs/
      registry.ts
      config/
      redaction/
      telemetry/
  db/
    prisma/
      schema.prisma
      migrations/
    src/
      client.ts
  client/
    src/
      generated/
docs/
  queuehouse-spec.md
```

## Process Model

Production runs at least four services:

- `api`: Hono API, Scalar docs, auth, and static React UI serving.
- `worker`: BullMQ workers, scheduled reconciliation, heartbeat, graceful shutdown.
- `redis`: BullMQ storage, ephemeral worker heartbeat, locks.
- `postgres`: Prisma-managed app metadata.

The API and worker use the same Docker image with different commands:

```txt
bun run start:api
bun run start:worker
```

Local development may provide an all-in-one convenience script, but production topology keeps API and workers separate.

## Job Registry

Jobs are defined statically in `packages/core/src/jobs` and registered in `packages/core/src/registry.ts`.

Each job definition includes:

- Globally unique dotted name, such as `email.sendWelcome`.
- Internal queue mapping.
- Input Zod schema.
- Output Zod schema.
- Schema version.
- Processor function.
- Retry defaults and allowed override bounds.
- Timeout.
- Priority support.
- Redaction config.
- Retention policy.
- Capabilities: external enqueue, UI enqueue, schedulable, internal-only.
- Optional dedupe-key function.

Example shape:

```ts
registerJob({
  name: "email.sendWelcome",
  queue: "email",
  schemaVersion: 1,
  input: z.object({ userId: z.string().uuid() }),
  output: z.object({ sent: z.boolean() }),
  capabilities: {
    externalEnqueue: true,
    uiEnqueue: true,
    schedulable: true,
    internal: false
  },
  retry: {
    attempts: 5,
    backoff: { type: "exponential", delayMs: 1000 },
    allowOverrides: true
  },
  timeoutMs: 30000,
  redaction: {
    paths: ["token", "password"]
  },
  processor: async (payload, ctx) => {
    ctx.log("Sending welcome email");
    return { sent: true };
  }
});
```

Job names are public contracts and should be treated as immutable. Queue names are operational details and may change for future enqueues.

## Job Data Envelope

BullMQ job data wraps user payload with framework metadata:

```ts
{
  payload: TInput,
  meta: {
    requestId: string,
    traceparent?: string,
    actorId?: string,
    source: "api" | "ui" | "schedule" | "system",
    schedulerId?: string,
    dedupeKey?: string,
    schemaVersion: number,
    enqueuedAt: string
  }
}
```

Processors receive only the typed payload and a framework context. Metadata is framework-owned and should not be mutated by processors.

## Processor Context

Processors receive:

- `signal`: `AbortSignal` for timeout and best-effort cancellation.
- `progress(value | object)`.
- `log(message, metadata?)`.
- `enqueue(jobName, payload, options?)` for follow-up jobs.
- `requestId`, `traceId`, `jobId`, `queue`, and `attempt`.

Output is validated with the declared output schema before completion. Output validation failure is treated as a processor bug and fails the job.

## Error Semantics

The framework provides typed error helpers:

- `retryable(message, details?)`.
- `unrecoverable(message, details?)`.
- `validation(message, details?)`.
- `timeout(message, details?)`.

Unknown thrown errors are retryable until attempts are exhausted. Unrecoverable errors skip remaining retries and enter DLQ immediately.

## Retry And DLQ

Failed jobs enter the managed DLQ view when attempts are exhausted or an unrecoverable error occurs.

Supported DLQ actions:

- Inspect redacted payload, result, logs, attempts, stack trace, and BullMQ options.
- Retry original job in place.
- Retry as new with edited payload and/or options.
- Discard/archive failed job.
- Delete retained job.
- Bulk retry selected or filtered failed jobs.

Manual retry resets attempts by default, with an option to preserve attempt count. Edited retry creates a new job and links it back to the original failed job.

## Deduplication

Deduplication is opt-in. Enqueue options may include `dedupeKey`, or job definitions may compute one from payload.

Deduplication maps to deterministic BullMQ `jobId`. Duplicate enqueue requests return the existing job with:

```json
{
  "status": "queued",
  "jobId": "email.sendWelcome:user-123",
  "deduped": true
}
```

## Scheduling

Scheduling is included in v1.

Admins can create, edit, disable, and delete schedules for statically registered schedulable job types.

Schedules support:

- Cron expressions.
- Friendly presets/builders.
- IANA time zones, defaulting to UTC.
- Fixed JSON payloads.
- Priority.
- Retry override within job-defined bounds.
- `startDate`, `endDate`, `limit`, and immediate-first-run options where supported.
- Next-run previews before saving.

Postgres is the source of truth for schedule metadata. BullMQ Job Schedulers are reconciled from Postgres on startup and schedule changes.

Disabling a schedule removes the BullMQ scheduler but keeps the Postgres row as disabled. Updating a schedule affects future generated jobs only.

Schedule rows store the job schema version they were validated against. If a schedule no longer validates after deployment, reconciliation removes/disables the BullMQ scheduler and marks the schedule as `needs_review`.

## API Surface

All API endpoints use `/api/v1`.

Primary enqueue endpoints are generated per job type:

```txt
POST /api/v1/jobs/email.sendWelcome
POST /api/v1/jobs/billing.syncInvoice
```

A generic fallback may exist:

```txt
POST /api/v1/jobs/:jobName
```

The public API exposes job types, not queue names. Queues remain operational concepts.

Core endpoint groups:

- `Auth`: login, logout, session, CSRF token.
- `Jobs`: enqueue, list, detail, retry, retry-as-new, discard, delete, bulk actions.
- `Queues`: list, pause, resume, stats.
- `Schedules`: create, list, detail, update, disable, delete, preview.
- `Workers`: current heartbeat and capacity.
- `Audit`: paginated audit records.
- `API Keys`: create, list, revoke.
- `System`: health, readiness, metrics, version.
- `Docs`: Scalar and OpenAPI JSON.

OpenAPI includes all admin endpoints, with tags and auth requirements. Docs are protected behind viewer/admin auth. If public enqueue docs are needed later, generate a filtered public spec.

## API Response Shape

Use a light response envelope:

```json
{
  "data": {},
  "meta": {},
  "error": null
}
```

Errors include:

```json
{
  "data": null,
  "meta": {
    "requestId": "req_..."
  },
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": []
  }
}
```

List endpoints use cursor-style API semantics even when backed internally by BullMQ range queries.

## Auth And Authorization

Auth supports:

- Cookie-based browser sessions.
- Bearer API keys for service clients.

Browser sessions:

- Stored in Postgres.
- HTTP-only cookies.
- `SameSite=Lax`.
- `Secure` in production.
- Absolute expiry plus sliding idle expiry.
- CSRF protection for cookie-authenticated mutation requests.

Passwords use `Bun.password.hash()` and `Bun.password.verify()`.

Roles:

- `viewer`: inspect jobs, queues, schedules, workers, docs, audit where allowed.
- `admin`: enqueue, retry, discard/delete, pause/resume, manage schedules, manage users/API keys.

Users can be created, disabled, and reset by admins. Disabling a user revokes active sessions immediately.

API keys:

- Stored hashed.
- Plaintext token shown once.
- Support owner type: `user` or `service`.
- Governed by explicit scopes and allowed job types.
- User-owned keys are denied if the owning user is disabled.

Minimum scopes:

```txt
jobs:enqueue
jobs:read
jobs:retry
queues:manage
schedules:manage
audit:read
system:read
```

## Audit Logging

Every admin mutation is audit-logged in Postgres:

- Manual enqueue.
- Retry.
- Retry as new.
- Discard/delete.
- Bulk actions.
- Queue pause/resume.
- Schedule create/update/disable/delete.
- User changes.
- API key create/revoke.
- Raw payload reveal.
- Manual retention cleanup.

Audit records contain actor, action, target type/id, timestamp, request id, redacted before/after summaries where relevant, and result.

Audit logs have their own retention policy, defaulting longer than job retention.

## Redaction And Raw Reveal

Job definitions declare redaction centrally. UI and API list/detail views return redacted payload/result by default.

Raw reveal is admin-only, explicit, and audit-logged with a required reason. Raw data is never included in list endpoints.

Viewers only receive redacted data.

## Admin UI

The UI is desktop-first but usable on mobile.

First screen: operational dashboard with:

- Queue health.
- Active/waiting/delayed/completed/failed counts.
- DLQ count.
- Worker status.
- Recent failures.
- Schedule health.
- Throughput and duration charts.

Primary navigation:

- Dashboard.
- Jobs.
- Queues.
- Schedules.
- Workers.
- Audit.
- Users.
- API Keys.
- Docs.

Design direction:

- shadcn neutral base.
- Status colors carry meaning.
- Dense, calm, operational layout.
- Dark mode supported and persisted only in local storage.
- Table filters, columns, density, sorting persisted only in local storage.

No marketing landing page. The app opens to the operational dashboard after login.

## Job UI

First-class job views:

- Waiting.
- Delayed.
- Active.
- Completed.
- Failed/DLQ.
- Scheduled.
- All jobs.

Filters:

- Queue.
- Job type.
- State.
- Date range.
- Attempt count.
- Priority.
- Scheduler id.
- Job id.

Job detail shows:

- Status and timeline.
- Redacted payload.
- Redacted result.
- Attempts and logs.
- Progress.
- Stack trace.
- BullMQ options and metadata in an advanced section.
- Retry/discard/delete actions depending on permissions and state.

Processor logs are stored as bounded BullMQ job logs and expire with job retention.

## Bulk Actions

Supported in v1:

- Bulk retry failed jobs.
- Bulk discard selected failed jobs.
- Bulk delete selected completed/failed jobs.

Bulk actions may target selected IDs or jobs matching current filters. Filter-based bulk actions require preview count and explicit confirmation.

Default cap: 1,000 jobs per bulk action, configurable by env.

Large or filter-based bulk actions run as internal system jobs. System/admin jobs use the same queue engine and appear in a separate `System` or `Admin operations` UI view.

## Retention

Retention is configurable in code/env and read-only in the UI for v1.

Defaults:

- Completed jobs: short retention, such as 24-72 hours.
- Failed/DLQ jobs: longer retention, such as 14-30 days.
- System jobs: 7-14 days.
- Audit logs: 90-180 days or configurable forever.

Retention cleanup runs as an internal scheduled system job.

## Observability

Health endpoints:

```txt
GET /healthz
GET /readyz
```

`/healthz` verifies the process is alive. `/readyz` checks Redis and Postgres with short timeouts.

Metrics:

```txt
GET /metrics
```

Prometheus text format. Include:

- Queue depth by state.
- DLQ counts.
- Processed/failed/retried counters.
- Job duration histograms.
- Worker heartbeat counts.
- API request duration.
- Redis/Postgres readiness.
- Schedule fire counts.

Metrics may include bounded labels like `queue` and `job_type`, never unbounded labels like `jobId`, user id, payload fields, or dedupe keys.

Tracing:

- OpenTelemetry support from v1.
- Exporter configured by env.
- Propagate trace context from enqueue request into job metadata.
- Link processor spans back to enqueue spans.

Logging:

- Structured JSON logs in production.
- Include request id, trace id, actor id, job id, job type, queue, worker id, and action when relevant.

Worker heartbeat:

- Stored in Redis with TTL.
- Includes worker id, host/container id, queues, concurrency, version, startedAt, and lastSeen.

## Config

Use typed config files for application policy and env vars for deployment/secrets.

Startup validates final config with Zod.

Required production guard:

- Refuse default/missing secrets in production.
- Refuse dev default admin credentials in production.
- Require database URL, Redis URL, session/CSRF secrets, CORS origins, and public app URL.

Use:

- `APP_ENV` for semantic environment: development, test, production.
- `NODE_ENV=production` for runtime/tooling behavior.
- `APP_NAMESPACE` for Redis/BullMQ prefixes.

## Database Ownership

Postgres stores:

- Users.
- Sessions.
- API key hashes and metadata.
- Audit logs.
- Schedule metadata.
- Retention/config metadata where needed.

Redis/BullMQ stores:

- Job lifecycle state.
- Job data.
- Job logs.
- Queue mechanics.
- Worker heartbeat.

Do not mirror every job into Postgres in v1. Add an analytics/search projection later only if needed.

## Deployment

Provide:

- `Dockerfile`.
- `docker-compose.yml` for production-like deployment.
- `docker-compose.dev.yml` for local hot reload and exposed Redis/Postgres.
- Optional `docker-compose.test.yml` for integration tests.

Database migrations run explicitly:

```txt
bun run db:migrate
```

Initial admin setup:

```txt
bun run setup:admin
```

Bootstrap creates an admin only when no admin exists, unless an explicit force-reset command is used.

## Testing

Unit tests:

- Registry validation.
- Zod schemas.
- Redaction.
- Permission checks.
- Retry policy resolution.
- Config parsing.
- Error classification.

Integration tests use real Redis and Postgres:

- Enqueue.
- Completion.
- Retry.
- DLQ.
- Deduplication.
- Delayed jobs.
- Cron scheduling.
- Schedule schema mismatch.
- Auth.
- API key scopes.
- Audit logging.

Contract tests:

- Generate OpenAPI from registry.
- Assert externally enqueueable jobs have paths and schemas.
- Assert internal-only jobs are excluded from public enqueue paths.
- Assert deprecated jobs are marked correctly.

UI tests with Playwright:

- Login.
- Dashboard loads.
- Job table filters.
- Manual enqueue validation.
- Schedule preview/create.
- DLQ retry flow.
- API key one-time token display.

CI generates OpenAPI/client and fails if the committed spec is stale or the web app cannot build against the generated client.

## Milestones

### Milestone 1: Spine

- Turborepo scaffold.
- Bun, Hono, React/Vite, Tailwind, shadcn.
- Docker Compose with Redis/Postgres.
- Prisma schema and migrations.
- Auth sessions and seeded admin.
- Static job registry.
- One or more example jobs.
- Enqueue, list, detail, retry, DLQ view.
- Zod/OpenAPI generation.
- Scalar docs.
- Basic dashboard.

### Milestone 2: Operations

- Schedules and cron.
- API keys and scopes.
- Audit log.
- Queue pause/resume.
- Worker heartbeat.
- Retention cleanup.
- Health/readiness.
- Prometheus metrics.

### Milestone 3: Recovery And Polish

- Bulk actions via internal system jobs.
- Retry as new with edited payload.
- Raw reveal with audit reason.
- OpenTelemetry.
- Full Playwright smoke suite.
- Dark mode and persisted table preferences.
- Advanced job detail panels.

## Non-Goals For V1

- Dynamic arbitrary queue creation from UI.
- External worker protocol where services pull/report jobs.
- First-class BullMQ flows/dependencies.
- Full multi-tenancy.
- Full-text payload/log search.
- Runtime-editable retention policies.
- Dynamic plugin loading.
- SQLite fallback.
- Public unauthenticated docs.

# PRD: Queuehouse

## Problem Statement

Teams need a queue service that is safe to operate, easy to inspect, and pleasant to deploy without being locked into a specific cloud platform. Existing queue setups often provide either a low-level queue engine with weak operational tooling, or a dashboard without a strongly typed API contract. The user wants a complete Bun-deployable queue system with a React admin UI, manual retry, managed DLQ workflows, scheduled and cron jobs, auditability, and a type-safe Zod/OpenAPI API surface.

The system should let developers define jobs safely in code, let services enqueue those jobs through a documented API, and let operators understand and recover queue failures without dropping into Redis internals.

## Solution

Build Queuehouse: a deploy-anywhere queue service for Bun that combines a Hono API, BullMQ/Redis queue engine, Prisma/Postgres metadata store, React/Vite/shadcn/Tailwind admin UI, Zod/OpenAPI contracts, and Docker deployment.

The product will provide statically registered typed jobs, per-job enqueue endpoints, protected Scalar API docs, a managed DLQ experience over failed BullMQ jobs, manual retry and retry-as-new flows, cron and delayed scheduling, API keys, session auth, audit logging, worker visibility, health checks, metrics, and staged production hardening.

## User Stories

1. As a backend developer, I want to define job types with Zod input schemas, so that invalid jobs are rejected before they enter the queue.
2. As a backend developer, I want each job type to declare an output schema, so that processor results are validated before jobs are marked complete.
3. As a backend developer, I want to register jobs statically in code, so that the API, worker, UI metadata, and OpenAPI spec all share one source of truth.
4. As a backend developer, I want globally unique dotted job names, so that clients can enqueue jobs without depending on internal queue names.
5. As a backend developer, I want job definitions to declare capabilities, so that the system knows whether a job can be externally enqueued, manually enqueued, scheduled, or kept internal.
6. As a backend developer, I want job definitions to include retry defaults and override bounds, so that clients can customize retries without creating unsafe retry storms.
7. As a backend developer, I want job definitions to include timeout settings, so that stuck jobs eventually fail and follow normal retry/DLQ behavior.
8. As a backend developer, I want job definitions to include redaction rules, so that sensitive payload fields do not appear casually in the UI or API.
9. As a backend developer, I want job definitions to include schema versions, so that old jobs and schedules can be reasoned about after schemas change.
10. As a backend developer, I want example jobs included, so that I have a clear pattern for defining success, progress, delay, and failure cases.
11. As an API client, I want a per-job enqueue endpoint, so that my generated client has precise request and response types.
12. As an API client, I want OpenAPI documentation for enqueue endpoints, so that I can integrate without reading Queuehouse internals.
13. As an API client, I want a generic enqueue fallback endpoint, so that tools can enqueue any registered job when job-specific generation is inconvenient.
14. As an API client, I want invalid enqueue payloads to fail synchronously, so that I can fix request data immediately.
15. As an API client, I want enqueue responses to include a job id, so that I can track the created job later.
16. As an API client, I want optional wait-with-timeout behavior for short jobs, so that I can use queue-backed execution without always building polling.
17. As an API client, I want deduplicated enqueue requests to return the existing job, so that retries of my own API calls are idempotent.
18. As an API client, I want API keys with explicit scopes, so that service integrations only receive the permissions they need.
19. As an API client, I want API keys restricted to allowed job types, so that a service cannot enqueue unrelated jobs.
20. As an API client, I want request ids returned in responses, so that I can correlate client errors with server logs and audit records.
21. As an operator, I want a dashboard as the first screen after login, so that I can immediately see queue health and failures.
22. As an operator, I want to see active, waiting, delayed, completed, failed, scheduled, and all-job views, so that I can inspect the queue from several operational angles.
23. As an operator, I want filters for queue, job type, state, date range, attempts, priority, scheduler id, and job id, so that I can find the exact jobs I need.
24. As an operator, I want job detail pages, so that I can inspect payload, result, logs, progress, attempts, stack traces, and metadata.
25. As an operator, I want redacted payloads by default, so that routine debugging does not expose secrets.
26. As an admin operator, I want a controlled raw reveal flow with a reason, so that I can inspect sensitive data during incidents while leaving an audit trail.
27. As an operator, I want processor logs and progress updates, so that I can understand what long-running jobs are doing.
28. As an operator, I want live UI updates through server-sent events, so that the dashboard reflects queue changes quickly.
29. As an operator, I want polling reconciliation in addition to live events, so that the UI recovers cleanly after reconnects.
30. As an operator, I want failed jobs presented as a managed DLQ, so that I have a clear recovery workflow rather than a raw failed set.
31. As an operator, I want to retry a failed job in place, so that I can rerun work after fixing an external dependency or deployment issue.
32. As an operator, I want manual retry to reset attempts by default, so that a job gets a fresh retry budget after intervention.
33. As an operator, I want the option to preserve attempt count on retry, so that special cases can keep original retry semantics.
34. As an operator, I want to retry as new with an edited payload, so that I can correct bad data without rewriting the original failed job.
35. As an operator, I want retry-as-new to link back to the original job, so that recovery history remains understandable.
36. As an operator, I want to discard failed jobs, so that known poison jobs can be intentionally abandoned.
37. As an operator, I want to delete retained jobs when appropriate, so that old data can be removed deliberately.
38. As an operator, I want bulk retry for selected failed jobs, so that I can recover from incidents efficiently.
39. As an operator, I want filter-based bulk actions with preview counts and confirmation, so that large recoveries are possible but guarded.
40. As an operator, I want bulk action caps, so that a single UI action cannot overload the queue or downstream systems.
41. As an operator, I want bulk actions to run as internal system jobs when large, so that they have progress, retry, and observability.
42. As an operator, I want system jobs to appear separately from product jobs, so that admin operations are visible without cluttering normal job views.
43. As an operator, I want queue pause and resume controls, so that I can stop and restart processing during incidents.
44. As an operator, I want worker heartbeat information, so that I can see which workers are alive and what capacity they provide.
45. As an operator, I want worker lifecycle control to stay in the deployment platform initially, so that the UI does not become a process manager.
46. As an operator, I want completed jobs retained briefly, so that I can debug recent successes without storing success history forever.
47. As an operator, I want failed jobs retained longer than completed jobs, so that DLQ recovery remains possible after incidents.
48. As an operator, I want retention policies visible in the UI, so that I understand when job data will disappear.
49. As an operator, I want retention cleanup to run automatically, so that Redis memory does not grow without bound.
50. As an admin, I want to create delayed jobs, so that work can run at a specific future time.
51. As an admin, I want to create cron schedules, so that recurring work can be managed by Queuehouse.
52. As an admin, I want friendly schedule builders and advanced cron mode, so that common schedules are easy and advanced schedules are still possible.
53. As an admin, I want schedule time zones, so that business-time schedules run when humans expect them to run.
54. As an admin, I want next-run previews before saving schedules, so that I can catch bad cron expressions.
55. As an admin, I want schedule payloads validated on create and update, so that invalid schedules are rejected early.
56. As an admin, I want saved schedules to store schema versions, so that stale schedules can be detected after deployments.
57. As an admin, I want schema-mismatched schedules to stop firing and require review, so that known-invalid recurring jobs do not flood the DLQ.
58. As an admin, I want schedule updates to affect future jobs only, so that already-created jobs are not silently rewritten.
59. As an admin, I want to disable schedules without losing their metadata, so that I can pause recurring work and re-enable it later.
60. As an admin, I want schedule management audited, so that recurring work changes are traceable.
61. As an admin, I want username/password login for the admin UI, so that operational actions are protected.
62. As an admin, I want passwords hashed with Bun password APIs, so that credential storage uses the runtime-native secure mechanism.
63. As an admin, I want viewer and admin roles, so that read-only users cannot mutate queues.
64. As an admin, I want basic user management, so that teams do not share one bootstrap account.
65. As an admin, I want disabled users to lose active sessions immediately, so that access revocation is effective.
66. As an admin, I want API keys shown only once and stored hashed, so that long-lived service credentials are handled safely.
67. As an admin, I want API key revocation, so that compromised or obsolete credentials can be disabled.
68. As an admin, I want cookie-authenticated mutations protected against CSRF, so that browser sessions are not abused cross-site.
69. As an admin, I want CORS locked to configured origins, so that browser access is intentionally scoped.
70. As an auditor, I want all admin mutations audit-logged, so that operational changes can be reviewed later.
71. As an auditor, I want audit records to contain redacted summaries, so that audit logs do not become a sensitive payload store.
72. As an auditor, I want audit logs retained longer than job data, so that operational accountability outlives queue cleanup.
73. As an auditor, I want raw reveal actions audit-logged with reasons, so that sensitive access is accountable.
74. As a platform engineer, I want health and readiness endpoints, so that deployment platforms can route traffic safely.
75. As a platform engineer, I want readiness to check Redis and Postgres, so that the API is only ready when dependencies are usable.
76. As a platform engineer, I want Prometheus metrics, so that queue behavior can be monitored with standard tooling.
77. As a platform engineer, I want metrics labeled by bounded dimensions like queue and job type, so that dashboards are useful without high-cardinality risk.
78. As a platform engineer, I want structured JSON logs, so that Docker logs can be collected and searched reliably.
79. As a platform engineer, I want OpenTelemetry hooks, so that enqueue requests and processors can be traced across async boundaries.
80. As a platform engineer, I want trace context stored in job metadata, so that worker spans can be linked to API requests.
81. As a platform engineer, I want graceful worker shutdown, so that deployments do not interrupt active jobs unnecessarily.
82. As a platform engineer, I want one Docker image reused for API and worker, so that API and worker versions stay aligned.
83. As a platform engineer, I want Docker Compose files for production-like, dev, and test setups, so that local and CI environments are reproducible.
84. As a platform engineer, I want explicit migration commands, so that database changes are controlled during deployment.
85. As a platform engineer, I want production guards against default secrets, so that unsafe deployments fail fast.
86. As a platform engineer, I want Redis keys namespaced by app/deployment name, so that environments can share Redis safely when needed.
87. As a frontend user, I want a desktop-first operational UI, so that tables, filters, logs, and detail panels are efficient to use.
88. As a frontend user, I want the UI to remain usable on mobile, so that urgent inspection or retry can happen away from a desk.
89. As a frontend user, I want dark mode persisted locally, so that my display preference follows the browser without server-side preference storage.
90. As a frontend user, I want table filters, columns, density, and sorting persisted locally, so that the UI remembers my workflow.
91. As a frontend user, I want copyable deep links to job detail pages, so that I can share operational context with teammates.
92. As a frontend user, I want expired job links to show a clear not-retained state, so that missing data is explained rather than confusing.
93. As a developer consuming the repo, I want a Turborepo monorepo, so that API, worker, UI, shared core, database, and generated client boundaries are clear.
94. As a developer consuming the repo, I want a deep queue framework module, so that enqueue, retry, dedupe, schedule, and DLQ behavior are testable behind stable interfaces.
95. As a developer consuming the repo, I want a deep auth module, so that sessions, API keys, scopes, CSRF, and actor resolution are consistent across routes.
96. As a developer consuming the repo, I want a deep registry module, so that job metadata drives OpenAPI, worker processing, UI metadata, and validation.
97. As a developer consuming the repo, I want a generated API client for the React app, so that frontend calls stay aligned with backend contracts.
98. As a developer consuming the repo, I want CI to verify OpenAPI freshness, so that generated docs do not drift from registered jobs.
99. As a developer consuming the repo, I want tests against real Redis and Postgres for queue behavior, so that retry, scheduling, and persistence are validated realistically.
100. As a developer consuming the repo, I want Playwright smoke tests for the admin UI, so that core operator workflows stay intact.

## Implementation Decisions

- Build the system as a Turborepo monorepo with separate API, worker, and web apps plus shared core, database, and generated client packages.
- Use Bun as the runtime across API, worker, scripts, and Docker.
- Use Hono for the HTTP API and static React UI serving.
- Use BullMQ on Redis as the queue engine rather than designing a custom database-backed queue.
- Use Postgres with Prisma for app metadata, not for mirroring every queue job.
- Use React, Vite, shadcn/ui, and Tailwind CSS for the admin UI.
- Use Zod as the schema source of truth and `@hono/zod-openapi` for OpenAPI generation.
- Use Scalar for protected API documentation.
- Expose all API routes under `/api/v1`.
- Generate per-job enqueue endpoints for registered externally enqueueable job types.
- Provide a generic enqueue fallback endpoint for tooling and internal flexibility.
- Treat job names as globally unique public contracts.
- Treat queue names as internal operational details that may change independently of job names.
- Keep job definitions statically declared in code for v1.
- Include job capabilities that control external enqueue, UI enqueue, schedulability, and internal-only behavior.
- Include schema versioning on job definitions and job metadata.
- Wrap BullMQ job data in a framework envelope that separates user payload from operational metadata.
- Keep operational metadata framework-owned after enqueue.
- Validate payloads at the API boundary and again defensively in the worker.
- Validate processor output before marking jobs complete.
- Provide typed processor context for abort signals, progress, logs, follow-up enqueue, and observability metadata.
- Normalize processor errors into retryable, unrecoverable, validation, and timeout categories.
- Send unrecoverable errors to DLQ immediately without consuming remaining retry attempts.
- Represent managed DLQ as a product abstraction over BullMQ failed jobs.
- Default manual retry to a fresh attempt budget, while allowing preserve-attempt behavior.
- Implement retry-as-new for edited payloads rather than mutating failed job history.
- Support opt-in deduplication using deterministic job ids and return existing jobs with a `deduped` flag.
- Support delayed jobs and cron schedules in v1.
- Store schedule metadata in Postgres as the source of truth and reconcile BullMQ Job Schedulers from it.
- Support schedule time zones, cron expressions, friendly builders, fixed payloads, run previews, priority, retry overrides, and enabled/disabled state.
- Stop firing schedules that no longer validate against the current job schema and mark them for review.
- Make schedule updates affect future generated jobs only.
- Use API keys for service clients and cookie sessions for the admin UI.
- Store sessions in Postgres with absolute and sliding expiry.
- Use `Bun.password.hash()` and `Bun.password.verify()` for passwords.
- Support viewer and admin roles.
- Support basic user management, including disabling users and revoking sessions.
- Store API keys hashed, show plaintext once, and govern access by explicit scopes and allowed job types.
- Apply CSRF protection to cookie-authenticated mutation routes.
- Lock CORS down to configured origins.
- Audit-log all admin mutations and raw reveal actions.
- Return redacted payload/result data by default.
- Allow admin-only raw payload/result reveal with an audited reason.
- Keep processor logs with BullMQ job data and audit logs in Postgres.
- Use cursor-style API list semantics even when adapters internally translate to BullMQ ranges.
- Use a light response envelope for data, metadata, and errors.
- Use Server-Sent Events for best-effort live UI updates plus polling reconciliation.
- Provide health, readiness, Prometheus metrics, structured JSON logs, and optional OpenTelemetry.
- Store worker heartbeat in Redis with TTL.
- Use one reusable Docker image with separate API and worker commands.
- Use explicit migration and admin setup commands rather than automatic startup migrations.
- Validate startup configuration with Zod and fail production startup on missing or default secrets.
- Use local storage for dark mode and table display preferences.
- Keep retention policy read-only in the UI for v1 and configured by code/env.
- Implement retention cleanup as an internal scheduled system job.
- Run large/filter-based bulk actions as internal system jobs.

Major modules to build:

- Job registry module: owns job definition shape, schema/version validation, capabilities, queue mapping, examples, and metadata queries.
- Queue engine module: wraps BullMQ enqueue, retry, retry-as-new, dedupe, listing, detail, state transitions, logs, progress, DLQ abstraction, and retention operations.
- Scheduler module: owns Postgres schedule records, cron validation, timezone handling, next-run previews, schema-version review, and BullMQ Job Scheduler reconciliation.
- Processor runtime module: owns worker construction, processor context, timeout/abort handling, output validation, error normalization, progress/log capture, and graceful shutdown.
- Auth module: owns session auth, API key auth, actor normalization, scope checks, role checks, CSRF, password hashing, and disabled-user enforcement.
- Audit module: owns mutation audit records, redacted summaries, raw reveal reason capture, and audit pagination.
- Redaction module: owns deterministic payload/result redaction and raw reveal authorization boundaries.
- OpenAPI module: owns route generation, per-job enqueue schemas, admin endpoint docs, security metadata, Scalar setup, and generated spec freshness checks.
- UI client module: owns generated client integration, response envelope handling, auth state, CSRF attachment, and request id/error handling.
- Admin UI module: owns dashboard, jobs table, job detail, DLQ actions, schedules, workers, audit, users, API keys, docs, local display preferences, and responsive layouts.
- Observability module: owns health/readiness checks, metrics, structured logging, trace propagation, and worker heartbeat.
- Deployment module: owns Dockerfile, Compose variants, environment validation, migration/setup commands, and production guards.

Deep modules that should be isolated behind stable testable interfaces:

- Job registry.
- Queue engine adapter.
- Scheduler reconciler.
- Processor runtime.
- Auth and authorization.
- Redaction.
- Audit writer.
- OpenAPI generation.
- Config loader.

## Testing Decisions

- Good tests should verify external behavior and contracts rather than private implementation details.
- Unit tests should cover pure modules such as registry validation, redaction, permission checks, retry policy resolution, error classification, config parsing, and OpenAPI route generation logic.
- Integration tests should run against real Redis and Postgres because queue behavior, retries, scheduling, deduplication, and persistence are timing-sensitive and mocks are likely to lie.
- API tests should verify auth, API key scopes, CSRF behavior, request validation, enqueue responses, retry behavior, DLQ behavior, schedule management, audit logging, and error envelopes.
- Worker tests should verify successful processing, output validation, timeout handling, unrecoverable errors, retryable errors, graceful shutdown behavior, progress/log capture, and metadata propagation.
- Scheduler tests should verify cron validation, timezone handling, next-run previews, create/update/disable/delete behavior, BullMQ reconciliation, and schema-mismatch stopping behavior.
- Contract tests should generate the OpenAPI spec from the job registry and verify externally enqueueable jobs are documented, internal jobs are excluded from public enqueue routes, deprecated jobs are marked, and the committed spec is fresh.
- UI smoke tests should use Playwright to cover login, dashboard load, jobs table filtering, job detail display, manual enqueue validation, schedule preview/create, DLQ retry, API key creation one-time token display, and raw reveal confirmation.
- Deployment tests should verify Docker build, migration command, setup command, health/readiness behavior, and production default-secret guards.
- Existing prior art in this repository is limited because the current codebase is greenfield and only contains the architecture spec. Testing conventions should therefore be established with the first implementation milestone.

Recommended modules for explicit test coverage:

- Job registry.
- Queue engine adapter.
- Scheduler reconciler.
- Processor runtime.
- Auth and authorization.
- Redaction and raw reveal.
- Audit logging.
- OpenAPI generation.
- Config validation.
- API route behavior.
- UI smoke workflows.
- Docker/deployment checks.

## Out of Scope

- Dynamic arbitrary queue creation from the UI.
- External worker protocol where outside services pull jobs and report results.
- First-class BullMQ flows or job dependency graphs.
- Full multi-tenancy or organization isolation.
- Full-text search across payloads and logs.
- Runtime-editable retention policies.
- Dynamic plugin loading for processors.
- SQLite fallback.
- Public unauthenticated docs.
- Complex role editor beyond viewer/admin and API key scopes.
- Server-persisted UI preferences or shared saved views.
- Runtime worker process control from the UI.
- Mirroring every queue job into Postgres for analytics.

## Further Notes

- The implementation should start with a staged milestone plan rather than attempting the whole production system in one pass.
- Milestone 1 should build the spine: Turborepo, Bun/Hono API, React UI shell, Redis/Postgres, Prisma auth, typed job registry, example jobs, enqueue/list/detail/retry, DLQ view, OpenAPI/Scalar, Docker Compose, and basic dashboard.
- Milestone 2 should add operational depth: schedules/cron, API keys/scopes, audit log, queue pause/resume, worker heartbeat, retention cleanup, health/readiness, and Prometheus metrics.
- Milestone 3 should add recovery and polish: bulk actions, retry-as-new editing, raw reveal, OpenTelemetry, Playwright coverage, dark mode/local preferences, and advanced job detail panels.

# Global active alerts view

## TODO

- None.

## IN PROGRESS

- None.

## DONE

- Defined the implementation ledger and verification requirements in this file.
- Audited the alert-event model, observability router, permissions, sidebar
  navigation, and dashboard page conventions.
- Added an organization-scoped unresolved-alert query that pairs firing and
  resolved transitions by organization, fingerprint, and firing cycle.
- Limited non-owner results to services explicitly accessible to the member.
- Preserved old unresolved firing incidents while retaining the 30-day cleanup
  behavior for completed history.
- Added search, severity, database type, project, environment, active-duration,
  and sort filters.
- Added `/dashboard/alerts` with loading, error, all-clear, filtered-empty, and
  populated incident states plus deep links to database monitoring.
- Added the Alerts sidebar entry with a polling unresolved-alert badge.
- Added regression coverage for transition pairing, tenant isolation,
  retention, router access, and filter combinations.
- Passed the complete observability suite: 79 tests passed and 5 Docker tests
  skipped, with no failures.
- Passed the Dokploy and server typechecks, targeted Biome checks, and the
  Dokploy server build.
- Verified the feature in Chrome with the running development environment:
  sidebar badge count, populated list, filtered results, filtered-empty reset,
  and database Monitoring deep-link navigation.

# Managed PostgreSQL and Redis monitoring

This file is the implementation ledger for the managed database observability
feature. Keep it current as work moves between sections.

## Finished

- Read the complete product and acceptance specification.
- Mapped the existing Drizzle, tRPC, permissions, database lifecycle, Docker
  Swarm, monitoring UI, notification, and migration extension points.
- Added `monitoringEnabled=true` to the PostgreSQL and Redis schemas.
- Added the observability persistence model for global settings, agents, alert
  rules, destinations, events, and deliveries.
- Added the public `DatabaseAlertRuleInput` schema.
- Added pinned tag+multi-architecture digest constants for Prometheus 3.12.0,
  Alertmanager 0.32.1, Grafana OSS 13.1.0, postgres_exporter 0.19.1, and
  redis_exporter 1.84.0.
- Added the stable PostgreSQL/Redis metric catalog, alert presets, metric query
  compiler, and Prometheus rule compiler.
- Added a fail-closed PromQL service-scope guard and allowed read-endpoint
  guard.
- Added portable Prometheus, Prometheus Agent, Alertmanager, Grafana
  datasource/dashboard provisioning, and dashboard generators.
- Added the first orchestration layer for immutable Docker configs/secrets,
  central stack services, per-server agents, per-database exporters, opt-out
  cleanup, and non-destructive stack disable.
- Isolated the central Prometheus, Alertmanager, Grafana services and persistent
  volumes per organization, including all Grafana, gateway, Remote Write, and
  server-side Prometheus routing.
- Completed the install/reconcile service layer, redacted stack/agent state,
  HTTPS enforcement for remote enrollment, best-effort exporter enrollment,
  alert rule synchronization, current metric reads, live alert states,
  expected-up exposition, portable ZIP export, and 30-day history cleanup.
- Added deduplicated Alertmanager event persistence and delivery through all
  existing Dokploy notification channel types with per-delivery results.
- Type-checked the complete `@dokploy/server` observability implementation.
- Added the `observability` tRPC router with stack install/state/reconcile,
  database opt-out, catalog/current value, destination reads, alert CRUD/live
  state/history, and artifact export.
- Added authenticated Grafana SSO proxy/ForwardAuth, service-scoped Prometheus
  gateway, per-agent Remote Write proxy, Alertmanager webhook, and expected-up
  metric endpoints.
- Moved all central and exporter credentials to Docker secrets, including
  Grafana datasource and Alertmanager webhook credentials.
- Hooked best-effort reconciliation into deploy, delete, and password rotation
  and added five-minute reconciliation plus daily history cleanup schedules.
- Generated Drizzle migration `0175_perfect_marvex.sql`.
- Added the PostgreSQL/Redis Monitoring UI with stack CTA, diagnostics,
  opt-out, embedded Grafana dashboard, catalog-only alert builder, presets,
  live/current values, history, artifact export, and existing charts under
  Resources.
- Type-checked the complete Dokploy application after API and UI integration.
- Added exporter health, live pending/firing states, alert editing, and
  non-destructive stack disable controls to the database Monitoring UI.
- Hardened PromQL isolation against mixed scoped/bare selectors and lookback
  injection, and added gateway tests for forged Grafana headers, cross-service
  access, cross-organization access, and administrative endpoints.
- Added immutable-secret rotation and garbage collection, Redis exporter JSON
  password-file support, per-organization Agent WAL volumes, shared-network
  Swarm discovery, and root-only Docker socket access for the Agent.
- Made Docker reconciliation fail visibly on daemon/permission failures while
  retaining idempotent handling for genuine 404 responses, and scoped immutable
  config versions by logical owner as well as content.
- Added router, permission, catalog, rule, Alertmanager transition/delivery,
  provisioning, orchestration, and security tests.
- Added an opt-in Docker integration suite covering PostgreSQL 13, Redis 7,
  both exporters, Prometheus Agent/Remote Write, Grafana Auth Proxy, pinned
  promtool/amtool validation, secret redaction, first metrics within four
  intervals, expected-up suppression, and sustained outage firing.
- Generated and re-verified Drizzle migration `0175_perfect_marvex.sql`; a
  second generation reports no schema drift.
- Passed 103 targeted Vitest tests (plus 5 opt-in skips), all 5 opt-in Docker
  integration tests, server and Dokploy typechecks, targeted Biome checks,
  all Go package tests, and the complete production build under Node 24.
- Ran the full repository Vitest suite: 717 passed and 6 skipped; the only
  three failures are pre-existing real-deployment tests requiring the absent
  external `nixpacks` binary.
- Re-ran feature Biome checks, both feature typechecks, 65 observability tests
  (plus 5 opt-in Docker skips), and the complete production build under Node 24
  after the final multi-organization isolation and Docker error-handling pass.
- Re-ran all 5 opt-in Docker integration tests successfully on the final source:
  both databases emitted metrics within four intervals, Grafana Auth Proxy
  required no second login, pinned promtool/amtool accepted every artifact,
  secrets stayed out of inspect output, and expected-stop/outage behavior held.
- Scoped ZIP exports and alert-event deduplication to the authorized service and
  organization, normalized gateway POST queries against parameter pollution,
  kept global stack controls owner/admin-only in the UI, and preserved the
  existing Dokploy Cloud monitoring path.
- Completed the final diff, generated-artifact, secret-exposure, and build
  mutation review; package exports were restored to development mode.

## In progress

- None.

## Pending

- None for the managed monitoring implementation.
- Repository-wide lint/typecheck still report unrelated baseline issues outside
  this feature; feature-scoped lint/typechecks and the production build pass.

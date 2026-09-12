# Compose preview environments

## MEMORY

- Objective: one Docker Swarm stack per trusted GitHub PR, multiple PRs concurrently, configurable worker reservation/capacity, lifetime and firewall policy in Dokploy.
- The colleague's existing Docker engine and resources must be preserved. All added worker components run in Docker. A dedicated Docker-in-Docker engine joins the existing Swarm; the outer engine remains outside Swarm.
- Production is a no-impact constraint. Do not reinitialize the manager or redeploy production applications to test this feature. Public ingress must be verified in addition to container health.
- Branch: `codex/compose-preview-environments`, base `07c4c8d1c` / `v0.29.14-flots.12`. PR: [#36](https://github.com/Flots-app/dokploy/pull/36), targeting `canary`.
- Production Dokploy's image and schema remain unchanged. Acceptance used a separate controller/database; production release and source activation follow the normal release process after review.
- Credentials are excluded from the repository. The temporary validation manager key, controller, database, database volume and local credential files were removed. The dedicated operational worker key remains configured in Dokploy.
- DinD shares the host kernel; it is not VM isolation for hostile tenants. Registry retention and hard storage quotas require separate configuration.

## TODO

- No implementation or live acceptance task remains. Production rollout instructions are in `ops/compose-preview/README.md` and `ACCEPTANCE.md`.

## IN PROGRESS

- None. Implementation and live acceptance are complete; delivery is tracked in PR #36.

## TO VERIFY

- On the future production release: apply additive migration 0179, configure the existing worker's reservation/capacity and source PR settings, verify firewall indicators and one new preview. This release was not deployed during acceptance.

## DONE

- Inspected the live staging monorepo through Dokploy MCP; confirmed the single mutable branch limitation and the user's requirement for a real Swarm worker.
- Added schemas/migration, GitHub lifecycle reconciliation, explicit preview variables and Compose overrides, immutable commit/image references, capacity locking and ownership checks.
- Added dashboard worker reservation, capacity and firewall settings; source PR configuration/list; dedicated child view for routes, deployments and container logs. Children inherit source read access and reject direct mutations.
- Installed the dedicated worker, worker proxy and three Dockerized firewall agents. Worker is Ready/Active with preview-only label. Every pre-existing colleague container retained its identity and state.
- Worker restart preserved node identity; saved firewall policy and preview services recovered. Agents report matching expected policy hashes and fresh status.
- Persisted preview exclusion constraints in existing website application settings through Dokploy without redeployment. Reservation refuses unsafe existing placements without changing them.
- Cloudflare MCP added a proxied `*.flots.app` wildcard; explicit existing records were preserved. Full HTTP and WSS routing verified through Cloudflare, main ingress and the private worker proxy.
- Monorepo PRs #800 and #801 ran concurrently, seven services each: backend, scheduler, frontend, back-office, Postgres, Redis and Mailpit. Both APIs, frontends and back-offices returned HTTPS 200; both WSS upgrades succeeded.
- Separate databases applied 110 and 114 migrations respectively. PR #801 retained marker 801 after redeployment; #800 retained marker 800 and all seven task IDs. Removing #801 left #800's tasks unchanged and API reachable.
- Capacity three rejected a fourth allocation before resource creation. A separate smoke preview expired and cleaned up while the full monorepo stayed unchanged.
- Verified per-service resource limits and absence of inherited source/project/environment sentinel variables. Own database and public HTTPS reachable; cross-PR database, manager, metadata and production origin IP blocked.
- Verified private Mailpit SMTP authentication using the example settings in an isolated probe; no mail sent.
- Both full and both smoke previews were removed. Verified removal of owned stacks, ingress routes, networks, volumes and unused labelled image tags. Fixed cleanup for multiple tags sharing an image ID, with ownership regression tests.
- Migration 0179 applied successfully to an isolated PostgreSQL database. App typecheck and Biome pass; 113 targeted tests pass. React Doctor 0.9.14 reports zero new diagnostics locally and in GitHub CI.
- All GitHub checks passed on implementation commit `33ff49019`: full tests, typecheck, build, quality, React Doctor and Plumber. Current commit checks are linked from the PR. Local Docker Desktop is not a Swarm manager, so three pre-existing real deployment tests rely on CI's configured environment.
- Temporary acceptance resources and credentials removed. Worker, proxy, firewalls and wildcard DNS remain installed for the release.
- Final public production API and dashboard probes returned HTTP 200 after cleanup.

## Production incident — 12 September 2026

Initial manager readdressing used `docker swarm init --force-new-cluster` and removed DNS registrations of existing standalone Compose containers on `dokploy-network`. Healthy containers and replica counts hid broken ingress; production monorepo domains returned 503. This was caused by the setup work.

Recovery temporarily routed to verified container IPs, reattached affected application endpoints with original IPs/aliases, and restored the original DNS-based Traefik configuration. API, dashboard and collaboration returned 200. Staging, back-office and Passbolt aliases were repaired too. The main proxy itself was not reattached, avoiding a global ingress interruption; its own name is not used as an upstream.

Root-only configuration/database backups and a hot Swarm snapshot remain on the manager under `/root/dokploy-preview-backup-20260912`. A hot snapshot is not a guaranteed cold recovery backup. Never repeat manager reinitialization for worker enrollment. The worker's firewall now translates only its dockerd control-plane connection from the manager's stale bridge address to Tailscale, preserving Swarm TLS and workload isolation.

## Sources

- [Implementation and CI, PR #36](https://github.com/Flots-app/dokploy/pull/36).
- [Acceptance evidence](ops/compose-preview/ACCEPTANCE.md): direct Docker/Swarm inspection, PostgreSQL queries, public HTTP/WSS probes and browser validation.
- [Docker Swarm administration](https://docs.docker.com/engine/swarm/admin_guide/).
- [Docker stack deployment](https://docs.docker.com/engine/swarm/stack-deploy/).
- [Docker firewall and DOCKER-USER](https://docs.docker.com/engine/network/firewall-iptables/).
- [GitHub PR webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request).
- [Cloudflare wildcard precedence](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/).
- [Cloudflare Universal SSL coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).
- [Mailpit SMTP configuration](https://mailpit.axllent.org/docs/configuration/smtp/).

Credentials and private configuration must not be recorded in this log or the PR.

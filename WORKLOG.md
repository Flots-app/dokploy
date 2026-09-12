# Compose preview environments

## MEMORY

- Production is an explicit no-impact constraint for all remaining work. Validate against a separate Dokploy instance; do not reinitialize the manager or redeploy production.
- User requirements: real Docker Swarm worker, all added worker components run in Docker, preserve every pre-existing colleague resource. Dashboard must configure reservation and capacity. Include Swarm/Dokploy firewall layers.
- Architecture: dedicated Docker-in-Docker engine on the colleague host (outer engine remains outside Swarm), SSH key authentication on Tailscale port 2222; build on worker, immutable image digests in registry, manager deploys stacks pinned to worker node ID.
- Source: Flots-app/dokploy, branch `codex/compose-preview-environments`, base `07c4c8d1c` / `v0.29.14-flots.12`.
- SSH credentials and registry credentials are excluded from source control. Existing dedicated native SSH service was disabled when execution moved into Docker.
- Swarm manager was readdressed from its Docker bridge IP to Tailscale. A root-only service/configuration export, database dump and hot Swarm snapshot exist on the manager. The reinitialization restarted Swarm tasks; all services returned to their previous replica counts. Existing standalone Compose applications remained running.
- Production incident (2026-09-12): readdressing the manager with `swarm init --force-new-cluster` removed DNS registrations of existing standalone containers on `dokploy-network`. Container health and replica counts alone missed this failure. Traefik returned 503 for production monorepo hostnames. Repaired by temporarily routing to verified container IPs, reattaching affected application endpoints with their original IPs/aliases, then restoring the original DNS-based Traefik configuration. API, dashboard and collaboration endpoints return 200 externally. Staging, back-office and Passbolt application aliases were repaired too. Do not reinitialize the manager again as part of this task; verify public endpoints and proxy-to-upstream DNS after every network change. The proxy container itself has not been reattached to avoid interrupting all ingress; its own name is not an upstream.
- Never mark this work complete until migration, regressions, two concurrent real previews, lifecycle cleanup, routing and firewall behavior have been verified and the PR is open.

## TODO

- Complete public/API/database checks for the second full monorepo preview.
- Finish review and CI; open the pull request against canary.
- Remove temporary validation credentials/resources after completing the acceptance tests.

## IN PROGRESS

- Two real monorepo PRs from an isolated local Dokploy/database. PR #801 is ready with seven services; #800 is building. Production Dokploy's image/schema remain unchanged.
- Reviewing resource ownership, API access and operational rollout instructions.

## TO VERIFY

- Public production health after each infrastructure/network change.
- CI in its configured Linux Swarm environment. Local regression suite has 868 passing tests, 3 real deployment tests fail because Docker Desktop is not a Swarm manager, and 1 test is skipped. Nixpacks itself now builds successfully; do not initialize the user's existing local engine just for this suite.
- Registry image retention is separate from local resource cleanup. DinD shares the host kernel and does not provide VM isolation or a hard disk quota.

## DONE

- Cloudflare MCP reconnected. Added a proxied wildcard record for `*.flots.app`; existing explicit records were preserved. Both smoke previews returned HTTPS 200 through Cloudflare, main Traefik and the worker proxy.
- Updated PR #801 while PR #800 kept the same Swarm task IDs. Removed #801's smoke stack while #800 remained reachable. Expired #800 afterward; cleanup succeeded and the full #801 monorepo kept all seven task IDs.
- Real capacity check at three allocated previews refused a fourth allocation before creating resources.
- Full monorepo PR #801: backend, scheduler, frontend, back-office, private Postgres, Redis and Mailpit are 1/1 on the worker. API health, frontend and back-office return HTTPS 200. No production or staging variables were inherited.
- Rebuilt and restarted only the dedicated worker container with GNU coreutils, no-new-privileges by default, log rotation and BuildKit GC. Worker rejoined with its original node ID; persisted firewall policy reapplied and preview services recovered. All pre-existing colleague container IDs were preserved.
- Deployed the reviewed firewall script to manager, outer worker host and inner engine agents. Their policy hashes and freshness checks are healthy.
- Added 16 lifecycle regression tests (closure/draft/base/labels, TTL, disabled source, failed cleanup retention, author access, retries and locking) plus manifest tests for multiple routes and immutable configs/secrets. Targeted suite: 72 passing tests. Typecheck, shared server build and repository-wide Biome pass.
- Dashboard verified in the browser: preview settings/list and a dedicated child view with URLs, deployments and container logs; mutation controls stay on the source.

- Migration 0179 applied successfully to a fresh, isolated PostgreSQL database. Production schema and Dokploy image remain unchanged.
- Repeated API and dashboard public health checks return 200 after recovery.
- Worker reconnection repaired without manager restart: its firewall translates only dockerd TCP 2377 from the manager’s stale advertised bridge address to its Tailscale address. Swarm TLS remains end-to-end.
- Persisted the existing preview exclusion constraint in the staging and production website application settings via the Dokploy API, without redeployment, so later deployments retain placement.
- Actual GitHub PRs #801 and #800 each run an independent two-service Swarm stack on the worker, with immutable GHCR image digests and healthy Postgres volumes. Both return their own PR number through the private proxy. CPU=1, memory=512 MiB and PID=512 limits verified on all four containers. Distinct database markers verified. Cross-PR database, manager, metadata and production-IP connections rejected; public HTTPS egress works. Project/environment/source sentinel variables do not appear in task environments.
- Temporary traefik.me routing was replaced by Cloudflare-backed preview hostnames after its shared certificate quota prevented reliable HTTPS.

- Full regression run: 848 passing tests, 3 existing real Nixpacks tests fail because Nixpacks is absent locally, 1 skipped. New reservation tests: 2 passing; reservation now refuses unsafe existing placements without mutating any service.
- Worker cgroup nesting uses the official Docker-in-Docker initialization; a container with 64 MiB / 0.25 CPU limits starts successfully.
- Real firewall test: public HTTPS works, tailnet/metadata connections are rejected and corresponding iptables counters increment. Host and engine agents report matching active policy hashes.

- Inspected live Dokploy through its MCP: staging monorepo is a single Compose service with a mutable branch; existing previews only support applications.
- Created the implementation branch `codex/compose-preview-environments`.
- Fast-forwarded the implementation base to `origin/canary` / `v0.29.14-flots.12` (`07c4c8d1c`).
- SSH authenticated through Tailscale. Worker inventory: 16 CPUs, 27 GiB RAM, Docker 29.8.0, Compose 5.5.1; existing services and proxy on ports 80/443.
- User confirmed: a real Swarm worker, not standalone Compose execution; preserve all colleague resources.
- Main Dokploy host can reach the worker through Tailscale.
- Started the dedicated Docker-in-Docker worker with key-authenticated SSH on Tailscale port 2222. Existing colleague Docker daemon, containers and proxy are preserved.
- Backed up manager configuration and database; readdressed its single-manager Swarm to Tailscale and verified restored service replica counts.
- Implemented initial schemas, explicit preview variables, commit-pinned clones, per-PR networks/resources, lifecycle queue and dashboard forms (validation ongoing).

## Sources

- Project source: `packages/server/src/services/compose.ts`, `apps/dokploy/pages/api/deploy/github.ts`, database schemas and deployment queue.
- [Dokploy preview deployments](https://docs.dokploy.com/docs/core/applications/preview-deployments).
- [Dokploy remote deployment servers](https://docs.dokploy.com/docs/core/remote-servers/deployments).
- [Docker Compose project isolation](https://docs.docker.com/compose/intro/compose-application-model/).
- [Docker Compose networks](https://docs.docker.com/compose/how-tos/networking/).
- [Docker Compose volume ownership](https://docs.docker.com/reference/compose-file/volumes/).

Credentials and private configuration must not be recorded in this log or the PR.

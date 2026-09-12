# Acceptance record — 12 September 2026

Validation used this branch's code and migration 0179 in a separate Dokploy
controller and PostgreSQL database. The worker belongs to the existing Swarm;
the production Dokploy image and schema were not upgraded for these tests.

## Installed infrastructure

- A dedicated Docker engine runs in `dokploy-preview-worker` on the colleague's
  host. It is a real Swarm worker, reserved with
  `com.dokploy.preview-only=true`. The outer Docker engine remains outside Swarm.
- The worker is Ready/Active. Its CPU/memory envelope is 10 CPUs / 16 GiB;
  application containers have their own CPU, memory and PID limits.
- Firewall agents run on the manager, worker host and inner engine. The controller
  verifies their policy hashes and freshness. The worker proxy is private to
  Tailscale and attached only to each preview's network.
- Cloudflare MCP created a proxied wildcard for `*.flots.app`, pointing to main
  ingress. Existing explicit DNS records were preserved.
- Every pre-existing colleague container retained its ID and previous running or
  stopped state. Only the worker and its host firewall were added to that engine.

## Tests on real resources

| Check | Observed result |
| --- | --- |
| Concurrent monorepo PRs | #800 and #801 each ran seven services on the dedicated worker |
| Public ingress | Both API health endpoints, frontends and back-offices returned HTTPS 200 |
| Collaboration | Both public WSS endpoints completed a WebSocket upgrade |
| Private databases | #800 applied 110 migrations; #801 applied 114; distinct acceptance markers 800 and 801 |
| Update isolation | Redeployed #801; its database marker survived and all seven #800 task IDs stayed unchanged |
| Removal isolation | Removed #801; all seven #800 task IDs stayed unchanged and its API still returned 200 |
| Expiry | Expired a separate smoke preview; its resources were removed while the full monorepo retained its task IDs |
| Capacity | A fourth allocation was rejected at worker capacity three, before creating a child or resources |
| Network isolation | Own database and public HTTPS reachable; other PR database, manager, metadata and production origin IP blocked |
| Variables | Project, environment and source sentinel variables absent from preview tasks |
| Resource limits | Smoke containers: 1 CPU, 512 MiB, 512 PIDs; full app settings: 1 CPU / 1024 MiB per service |
| Worker recovery | Restarted only the dedicated worker container; original node identity, saved policy and preview services recovered |
| Mail | Example Mailpit SMTP authentication accepted dummy credentials in a network-isolated probe; no mail sent |
| Dashboard | Source settings/list, child routes, deployment history and actual container log lines verified in browser |
| Final cleanup | Both full and both smoke previews closed; their stacks, routes, volumes and owned unused image tags removed |

Cleanup originally retained images when several build tags shared one image ID.
The final implementation removes each owned tag, preserves tags outside the
preview namespace, and skips images referenced by running or stopped containers.
Four regression cases cover these ownership boundaries. The same cleanup was
then run successfully against the retained validation images.

## Automated checks

- 113 targeted tests pass, covering manifests, lifecycle, worker reservation,
  webhook handling, permission checks and image ownership.
- App typecheck and repository formatting/lint checks pass.
- React Doctor 0.9.14 reports zero new diagnostics locally against `origin/canary`.
- All checks passed on implementation commit `33ff49019`: full test suite,
  typecheck, quality, build, React Doctor and Plumber. See the current checks on
  [PR #36](https://github.com/Flots-app/dokploy/pull/36).
- Local Docker Desktop is not a Swarm manager. The three existing real deployment
  tests cannot finish there; they pass in the configured GitHub CI environment.

## Production incident and recovery

During initial worker setup, running `swarm init --force-new-cluster` on the
manager removed DNS registrations of existing standalone Compose endpoints on
`dokploy-network`. Production monorepo ingress returned 503 despite healthy
containers. The affected endpoints were reattached with their original IPs and
aliases, and original DNS-based Traefik routing was restored. Public API,
dashboard and collaboration recovered. This incident is recorded in WORKLOG.md.

The rollout procedure explicitly forbids reinitializing a working manager.
Reservation now refuses unprotected existing placements without changing them.
Subsequent validation used the separate controller and did not redeploy production
applications. Public API and dashboard health were checked after cleanup.

## Release handoff

The installed worker is prepared, but the new dashboard and lifecycle controller
become available on production Dokploy only after this PR is merged and released
through the normal process. No production schema migration or controller upgrade
was performed as part of acceptance.

After release, use the existing worker server, reserve it with capacity three,
verify all firewall indicators, and configure the staging monorepo source's
**PR environments** tab with the existing GHCR registry, base `main`, suffix
`flots.app`, 24-hour lifetime and the two files in `examples/`. Existing previews
snapshot settings at creation; remove and recreate one to apply changed settings.
The staging source's branch does not need to change.

Validation stacks are temporary and were removed. Registry artifacts have separate
retention. Docker-in-Docker shares the host kernel and provides neither VM tenant
isolation nor a hard disk quota; use dedicated VMs for hostile workloads.

## Evidence and sources

- Direct Docker engine/Swarm inspection, public HTTP/WSS probes and isolated
  PostgreSQL queries during acceptance.
- [Implementation and CI](https://github.com/Flots-app/dokploy/pull/36).
- [Docker Swarm stack deployment](https://docs.docker.com/engine/swarm/stack-deploy/).
- [Docker firewall behavior](https://docs.docker.com/engine/network/firewall-iptables/).
- [Cloudflare wildcard precedence](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/).
- [Cloudflare Universal SSL coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).
- [Mailpit SMTP settings](https://mailpit.axllent.org/docs/configuration/smtp/).

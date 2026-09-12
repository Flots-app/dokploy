# Docker Compose PR environments on Swarm

This feature adds an independent environment and Swarm stack for each eligible
GitHub pull request. A source Compose keeps its branch, environment and runtime.
Images are built on the preview worker, pushed to the configured registry and
referenced by digest in Swarm. Every service is pinned to the selected worker.

## Rollout without interrupting existing applications

1. Back up Dokploy's database and record existing service placements and public
   health checks. Apply the additive migration with the normal Dokploy release.
2. Prepare a dedicated Docker engine for previews. On a shared host, use the
   supplied Docker-in-Docker container to keep the colleague's Docker resources
   outside the cluster. Do not initialize Swarm on that host's existing daemon.
3. Join the dedicated engine as a **worker with availability `pause`**. Never use
   `swarm init --force-new-cluster` to add a worker to a working production cluster.
4. Verify every existing service excludes preview nodes. This release adds
   `node.labels.com.dokploy.preview-only!=true` to ordinary Dokploy deployments.
   Older services need that constraint persisted in their Dokploy settings and
   deployed through their normal release process. Changing a service's placement
   may restart it. The reservation action refuses unprotected services; it never
   updates them itself. Keep the worker paused until this precondition is met.
5. Install the firewall agents, apply a policy, then select the worker's manager
   and reservation/capacity in **Settings → Servers → server actions**.
6. On a GitHub Compose source, open **PR environments**. Select worker, registry,
   base branch, Compose path, DNS suffix, resources, capacity and lifetime. Provide
   explicit preview variables and, if necessary, a complete Compose override.
7. Test two PRs, public routes, resource placement, negative network tests and
   cleanup before enabling the source's production webhook flow.

Do not redeploy production applications to test previews. Verify public health
and proxy-to-upstream DNS after any infrastructure network change: a running
container and a healthy replica count do not prove ingress is working.

## Dedicated worker

`worker/compose.yml` publishes only to `PREVIEW_TAILSCALE_IP`. Supply
`PREVIEW_PUBLIC_KEY_FILE` pointing to a dedicated public SSH key. State and Docker
storage use the project's own named volumes. SSH listens on port 2222 inside the
container, requires public-key authentication and disables SSH forwarding. The
Docker API uses a Unix socket only. The image contains GNU coreutils because
checkout validation requires `realpath -m`, including symlink resolution.

The outer engine stays outside Swarm. Do not run `docker system prune`, remove
other containers, change the colleague's proxy, or reuse their networks/volumes.
Use the explicit Compose project when operating on this installation.

The Docker-in-Docker wrapper initializes cgroups before starting the custom
entrypoint. The outer container limits aggregate CPU/memory. It is privileged
and shares the host kernel: **it is not a VM or a boundary for hostile tenants**.
Only same-repository PRs from authors with write access are accepted. For hostile
or public-fork workloads, provision dedicated VMs instead.

Inside the worker, install the engine firewall agent and a dedicated Traefik
Docker-provider proxy on port 9080. Use the same firewall image for all agents:

```sh
docker build -t dokploy-preview-firewall:1 ops/compose-preview/firewall
# Run inside the dedicated worker engine:
docker run -d --name dokploy-preview-firewall --restart unless-stopped \
  --network host --cap-add NET_ADMIN --cap-add NET_RAW --read-only \
  --security-opt no-new-privileges:true \
  --label com.dokploy.preview-infrastructure=true \
  -e PREVIEW_FIREWALL_ROLE=worker-engine \
  -v /etc/dokploy:/policy dokploy-preview-firewall:1
```

The outer worker-host agent is included in `worker/compose.yml`. Install the
manager agent with role `manager`, host networking and
`/etc/dokploy/preview-firewall:/policy`. All three agents need the policy installed
before they report healthy. Keep pre-existing firewall rules intact.

`worker/engine-compose.yml` defines the two inner containers. Copy it into the
worker, load the built firewall image into that engine, and run it with
`PREVIEW_MANAGER_IP` set to the manager's Tailscale address. The manager agent
has its own `firewall/manager-compose.yml`. For an existing manual installation,
adopt only these explicitly named infrastructure containers; preserve the Docker
and state volumes. Do not use `--remove-orphans` on a colleague's installation.

The worker daemon rotates container logs at 3 × 10 MB and enables BuildKit garbage
collection with a 6 GB cache target. Builds refuse to start below 10 GiB free
space. This is a preflight check, not a disk quota: provision a separate filesystem
with a quota if a hard storage boundary is required. Cleanup removes the PR's
logs, volumes, unused labelled images and unused versioned configs/secrets.
Images in use by Swarm tasks are retained. Registry images remain available for
diagnostics; configure retention for the generated `preview-*` repositories in
the registry separately. No global Docker or registry pruning is performed.

## Firewall and ingress

| Layer | Enforcement |
| --- | --- |
| Tailscale | Transport between hosts; service ports bind only to the tailnet IP |
| Manager INPUT | Swarm ports 2377/TCP, 7946/TCP+UDP, 4789/UDP allowed from configured workers |
| Worker host DOCKER-USER | Filters Docker-published preview ports using original conntrack destination |
| Worker engine | Only the manager reaches Swarm/proxy; configured administrator IPs reach SSH |
| Workload egress | Rejects private, tailnet, metadata and configured destination addresses |
| PR network | One private overlay per stack; no shared application network or published service ports |

Agents manage only `DOKPLOY-PREVIEW-*` chains. They do not flush Docker, Tailscale
or existing chains. Rules are reconciled every ten seconds; Dokploy checks the
policy hash and freshness of all three agents before deploying. The engine starts
with forwarded egress blocked until its firewall applies the saved policy.

An optional `controlPlaneMappings` policy translates only the engine's own TCP
2377 connections when an existing manager advertises a bridge IP that cannot be
routed from the worker. The dashboard derives this mapping from the selected
manager's reported addresses. This is deployment-specific compatibility logic,
not a change to Swarm membership or TLS. It does not expose the Docker API or
allow workloads to reach the manager. A clean installation should advertise its
reachable Tailscale address from the outset.

Main Traefik terminates HTTPS and forwards new preview hosts to the worker's
private port 9080 with the original Host header. The dedicated worker Traefik uses
Docker labels constrained to `com.dokploy.preview=true`, with exposed-by-default
false, and is connected only to preview overlay networks. Main Swarm Traefik
ignores these services. Existing domain files are not modified. Configure a
wildcard DNS record for the selected preview suffix to point at main ingress.
With Cloudflare Universal SSL, use a single-level hostname below the zone, such
as `preview-…-pr-801-api-….example.com`, and a proxied `*.example.com` record.
Existing explicit records take precedence. A nested `*.preview.example.com`
requires suitable certificate coverage; Universal SSL does not cover that depth.

## Preview application contract

- Compose must describe the complete preview. Staging/project variables are not
  inherited, and external database addresses are not copied automatically.
- Add private Postgres/Redis/etc. services and named volumes to the preview file.
  Bake initialization files into images or use repository configs/secrets.
- Host ports and container names are removed. External volumes, bind mounts,
  privileged settings and host namespaces are rejected. Paths and resolved
  symlinks must stay within the checkout.
- CPU and memory limits apply per service. Swarm services are initially created
  at zero replicas, then activated with a 512-process limit before tasks start.
  Compose `depends_on` does not order Swarm startup: applications must retry
  dependencies. Provide health checks for meaningful readiness.
- Preview variables support `${{DOKPLOY_PR_NUMBER}}`,
  `${{DOKPLOY_PREVIEW_PASSWORD}}` and generated service URLs. A service named
  `backend-api` receives `DOKPLOY_PREVIEW_BACKEND_API_URL`, plus port-specific
  `DOKPLOY_PREVIEW_BACKEND_API_8080_URL` and `..._1234_WS_URL` when those routes
  exist on the source. Escape Dockerfile shell variables as `$$` in Compose.
- Only open, non-draft, same-repository GitHub PRs against the selected base branch
  and required labels qualify. The PR author's repository write access is checked.
  Git checkouts use an immutable SHA and a repository-scoped read token; the token
  is not saved in the repository remote configuration.

## Lifecycle and recovery

Webhook signatures are validated before dispatch. The reconciler retrieves the
current PR from GitHub, so duplicate/out-of-order deliveries cannot select an
obsolete branch or reopen a closed PR. A periodic pass also detects missed close
webhooks and expiry. Missed *new* PR events can be recovered with Deploy/resume.

Capacity allocation locks the worker row in PostgreSQL; the per-source limit and
worker-wide limit are checked in the same transaction. Per-preview advisory locks
prevent simultaneous deployment/cleanup by multiple controller processes.

Close, draft conversion, lost label eligibility, disabling the source, explicit
removal or expiry removes only the owned stack, ingress, network and volumes.
Deletion waits for Swarm tasks to stop. Failed cleanup retains its database record
and capacity reservation for retry. Expired or manually removed previews remain
closed until explicitly resumed. A failed commit is not rebuilt every minute;
new requests or commits allow retry. Updates preserve that PR's named volumes.

Direct edits/deployments of generated Compose children are rejected. Read access
follows the source service, including revocation. Manage children through the
source's PR environments tab. Delete active previews before deleting a source or
project. Current preview settings/variables are snapshotted at creation; remove
and recreate an existing preview to apply changed configuration.

`examples/flots-compose.yml` and `examples/flots.env.example` provide the initial
Flots monorepo override: backend, scheduler, frontend, back-office, private
Postgres with migrations, Redis and Mailpit. Paid integrations and external
storage are disabled. Mail stays in the private preview mail server. Supply
dedicated sandbox integration credentials explicitly when testing those features.

## Sources

- [Docker stack deployment and legacy Compose format](https://docs.docker.com/engine/swarm/stack-deploy/)
- [Docker Swarm administration](https://docs.docker.com/engine/swarm/admin_guide/)
- [Docker Swarm networking and advertised addresses](https://docs.docker.com/engine/swarm/networking/)
- [Docker firewall and DOCKER-USER](https://docs.docker.com/engine/network/firewall-iptables/)
- [Docker service process limits](https://docs.docker.com/reference/cli/docker/service/create/)
- [Docker daemon no-new-privileges](https://docs.docker.com/reference/cli/dockerd/)
- [Docker build cache garbage collection](https://docs.docker.com/build/cache/garbage-collection/)
- [Cloudflare wildcard DNS precedence](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)
- [Cloudflare Universal SSL coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)
- [Official Docker-in-Docker wrapper](https://github.com/moby/moby/blob/master/hack/dind)
- [GitHub pull_request events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)
- [Dokploy application previews](https://docs.dokploy.com/docs/core/applications/preview-deployments)

# Docker Compose PR environments on Swarm

This feature adds an independent environment and Swarm stack for each eligible
GitHub pull request. A source Compose keeps its branch, environment and runtime.
Images are built on the preview worker, pushed to the configured registry and
referenced by digest in Swarm. Every service is pinned to the selected worker.

See [the acceptance record](ACCEPTANCE.md) for the two concurrent Flots monorepo
tests, cleanup results, installed infrastructure and release handoff.

## For developers: what happens on your PR

1. Open a non-draft PR against the configured base branch, from a branch of the
   same repository (forks are never deployed). If the service requires labels,
   add one of them.
2. Within seconds Dokploy posts **one comment** on the PR and keeps editing it:
   🔄 Deploying → ✅ Ready (or ❌ Failed), with one URL per service, the commit,
   the expiry time and links to the PR environments tab and the build log.
3. Every push redeploys the PR on its new commit and restarts its lifetime.
   A broken commit does not take down the previous working version of a running
   service: Swarm rolls it back and the comment shows the failure.
4. Closing or merging the PR, converting it to draft, or reaching its lifetime
   removes the environment **and its data** (databases included). Push a commit
   or reopen the PR to get a fresh one.

When a deploy fails, the comment and the PR environments tab show the step and
the reason (for example `Compose validation: Preview service api: cap_add is not
supported`). The build log, opened from either place, has every command's
output and, after the stack started, the Swarm task errors and the last log
lines of every container. If the environment waits for capacity, it starts by
itself as soon as another PR closes.

Variables available in the PR environment variables editor:

| Placeholder | Value |
| --- | --- |
| `${{DOKPLOY_PR_NUMBER}}`, `${{DOKPLOY_PR_BRANCH}}` | The PR number and head branch |
| `${{DOKPLOY_PREVIEW_PASSWORD}}` | A random secret, stable for the PR's lifetime |
| `${{DOKPLOY_DEPLOY_URL}}` | The URL of the first domain |
| `${{DOKPLOY_PREVIEW_<SERVICE>_URL}}` | Public URL of a service (`backend-api` → `BACKEND_API`) |
| `${{DOKPLOY_PREVIEW_<SERVICE>_<PORT>_URL}}`, `..._WS_URL` | Per-port HTTP and WebSocket URLs |

They are also written to the stack's `.env` under the same names.

## Rollout without interrupting existing applications

1. Back up Dokploy's database and record existing service placements and public
   health checks. Apply the additive migration with the normal Dokploy release.
2. Prepare a dedicated Docker engine for previews. On a shared host, use the
   supplied Docker-in-Docker container to keep the colleague's Docker resources
   outside the cluster. Do not initialize Swarm on that host's existing daemon.
3. Join the dedicated engine as a **worker with availability `pause`**, advertising
   its reachable (Tailscale) address for both control and data traffic. Run this
   inside the worker, with the token from `docker swarm join-token worker` on the
   manager:

   ```sh
   docker swarm join --availability pause \
     --advertise-addr "$PREVIEW_TAILSCALE_IP" --data-path-addr "$PREVIEW_TAILSCALE_IP" \
     --token "$WORKER_JOIN_TOKEN" "$MANAGER_TAILSCALE_IP:2377"
   ```

   Never use `swarm init --force-new-cluster` to add a worker to a working
   production cluster: that caused the 12 September 2026 ingress incident.

   Once the manager firewall agent runs, it only accepts Swarm traffic from
   nodes already listed by `docker node ls`. To add any node later (a preview
   worker or a regular one), first add its address under **Nodes about to join
   the Swarm** in a worker's preview network firewall, apply, wait for the
   manager agent to report healthy, then run `docker swarm join`. Remove the
   entry once the node appears in `docker node ls`. Re-apply the policy after a
   node's address changes.
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
entrypoint. The outer container limits aggregate CPU, memory and processes
(`pids_limit: 8192`, which also caps PR image builds). It is privileged and
shares the host kernel: **it is not a VM or a boundary for hostile tenants**.
A container escape on the inner engine is root on the host. Only
same-repository PRs from authors with write access are accepted. For hostile or
public-fork workloads, give the worker its own VM (or a microVM runtime such as
Kata or Firecracker, or Sysbox instead of a privileged container). Enabling
`userns-remap` on the inner daemon is a further hardening step; validate Swarm
tasks and named volumes with it before relying on it.

Inside the worker, install the engine firewall agent and a dedicated Traefik
Docker-provider proxy on port 9080, from `worker/engine-compose.yml`. Use the
same firewall image for all agents:

```sh
docker build -t dokploy-preview-firewall:1 ops/compose-preview/firewall
# Load it into the dedicated worker engine, copy engine-compose.yml there, then
# run inside that engine:
PREVIEW_MANAGER_IP=<manager tailnet IP> docker compose -f engine-compose.yml up -d
```

The outer worker-host agent is included in `worker/compose.yml`. Install the
manager agent with role `manager`, host networking and
`/etc/dokploy/preview-firewall:/policy`. All three agents need the policy installed
before they report healthy. Keep pre-existing firewall rules intact.

`worker/engine-compose.yml` defines the inner containers: the engine firewall
agent, a Docker socket proxy that only answers the read-only calls Traefik needs,
and the preview Traefik (pinned by digest, read-only, all capabilities dropped
except binding port 80). Traefik joins every PR network, so it never mounts the
Docker socket itself. Copy it into the
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
Images in use by Swarm tasks are retained. No global Docker or registry pruning
is performed.

**Registry retention is required.** Each deploy pushes one tag per built service
(`<registry>/<prefix>/preview-<hash>-pr-<n>-<service hash>:<deployment id>`) and
Dokploy never deletes registry content. Configure a lifecycle rule on the
`preview-*` repositories of the selected registry, for example: keep the last
5 tags per repository and delete tags older than 14 days (GHCR: a scheduled
`actions/delete-package-versions` workflow; Harbor/ECR/GAR: a native retention
policy).

## Firewall and ingress

| Layer | Enforcement |
| --- | --- |
| Tailscale | Transport between hosts; service ports bind only to the tailnet IP |
| Manager INPUT | Swarm ports 2377/TCP, 7946/TCP+UDP, 4789/UDP allowed from every Swarm node (read from the live cluster) and preview workers |
| Worker host DOCKER-USER | Filters Docker-published preview ports using original conntrack destination |
| Worker engine INPUT | Only the manager reaches Swarm; configured administrator IPs reach SSH |
| Worker engine DOCKER-USER | Only the manager reaches the preview proxy (published port 9080, matched on the original destination port) |
| Workload egress | Rejects private, tailnet, metadata, every server registered in Dokploy, the manager, and configured addresses. DNS (port 53 only) stays open to the worker's resolvers that Dokploy can read, and to the **Private DNS resolvers for PR builds** listed in the firewall settings. A Docker-in-Docker worker on a Compose network only shows Docker's embedded resolver (127.0.0.11): its inner engine then uses public resolvers for builds, and PR overlays resolve through the worker. Where public DNS is blocked, list the private resolver in the firewall settings; Dokploy cannot detect it |
| PR network | One private overlay per stack; no shared application network or published service ports. The worker's Traefik joins every PR overlay to route it, so a PR can reach another PR's **public** routes through it, as anyone on the internet can |

Agents manage only `DOKPLOY-PREVIEW-*` chains. They do not flush Docker, Tailscale
or existing chains. Rules are reconciled every ten seconds; Dokploy checks the
policy hash and freshness of all three agents before deploying. The engine starts
with forwarded egress blocked until its firewall applies the saved policy.

The manager's peer list is rebuilt from `docker node ls` on every save. Dokploy
refuses to save when a node's address cannot be determined, rather than writing
a rule that would cut it off. Public addresses Dokploy does not know, such as the
worker host's own public IP, must be added to the blocked addresses by hand:
traffic from a PR to its own host never crosses the cloud firewall.

Agents report health through `/policy/<role>-status.json` and a Docker
healthcheck. After a reboot or a Docker restart, Docker's own rules are rebuilt
and the agents re-apply theirs within about ten seconds; the published ports
listen only on the tailnet address during that window.

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
- CPU, memory and a 512-process limit apply per service from its first task
  (stack schema 3.12, so the Swarm manager needs Docker CLI 25 or later).
  Services that already run keep serving until they are updated, and roll back
  automatically when the new version fails to start.
- A deploy is ready when every service has run (and passed its healthcheck)
  for 20 seconds without being restarted, within 5 minutes. Image builds are
  killed after 30 minutes and each push after 15 minutes.
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
worker-wide limit are checked in the same transaction. A PR over capacity waits
and starts automatically once a slot frees up. A per-preview lease
(`lockedBy`/`lockedUntil`, renewed every two minutes, expiring after ten)
prevents simultaneous deployment/cleanup by several controller processes without
holding a database connection for the whole deploy; a crashed process's lease
expires on its own.

GitHub state is read with conditional requests, so polling an unchanged PR does
not use the installation's rate limit. Ready and failed environments are
re-checked every five minutes (webhooks bring changes in real time); in-flight
and waiting ones every minute. Closed records are purged after 30 days.

Close, draft conversion, lost label eligibility, disabling the source, explicit
removal or expiry removes only the owned stack, ingress, network and volumes.
Deletion waits for Swarm tasks to stop. Failed cleanup retains its database record
and capacity reservation for retry. The lifetime restarts on every new commit:
an expired environment comes back on the next push. A manually removed one stays
removed until someone redeploys it from Dokploy. A failed commit is not rebuilt
every minute; new requests or commits allow retry. Updates preserve that PR's
named volumes.

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

## Upgrading from an earlier build

PR environments only run on a worker reserved for previews. A worker that ran
previews without the reservation turns its next deploy into an error: reserve
it (server actions) or remove its environments. An expired environment comes
back on new code only (PR opened, reopened or pushed). Adding a required label
or leaving draft recreates an environment removed for that reason, but not an
expired one.

## Operate, debug and roll back

Check the state of an environment from the Dokploy host's database or the
dashboard; check the infrastructure on the hosts:

```sh
# Manager: stacks, tasks with their errors, firewall agent
docker stack ls | grep preview-
docker stack ps --no-trunc preview-<hash>-pr-<n>
iptables -S DOKPLOY-PREVIEW-IN
cat /etc/dokploy/preview-firewall/manager-status.json

# Worker (inside the dedicated engine): containers, firewall chains, agents
docker ps --filter label=com.dokploy.preview=true
iptables -S DOCKER-USER; iptables -S DOKPLOY-PREVIEW-OUT; iptables -S DOKPLOY-PREVIEW-PROXY
cat /etc/dokploy/worker-host-status.json /etc/dokploy/worker-engine-status.json
```

Common failures:

| Message | Fix |
| --- | --- |
| `Preview firewall is not healthy: … agent stopped reporting` | Restart that agent (`docker compose … up -d firewall`) and read its logs |
| `Preview worker is unreachable over SSH` | Check the worker container, port 2222 on the tailnet, and the SSH key in Dokploy |
| `Waiting for capacity` | Close a PR, or raise the worker capacity or the service limit |
| `Reserve this server for Compose previews first` | PR code only runs on a reserved worker: turn on the reservation in the server's actions |
| Removal keeps failing because the worker or manager is gone for good | An owner or admin uses **Forget** on the failed PR environment. Dokploy refuses while the worker still answers (use Remove then); otherwise it deletes the records without contacting any server, and leftovers on that machine are removed by hand |
| `Registry did not return an immutable digest` | Check the registry credentials and that the registry supports digests |
| `Services did not stay healthy … (api is unhealthy)` | Read the container logs in the build log; fix the healthcheck or the start command |

To take previews out of service: turn **Enable PR environments** off on each
source (this removes every environment, even if the worker is gone), then set
the worker's policy back to regular in its server actions (Dokploy refuses while PR environments still run on it). To remove the
firewall agents, run their uninstall mode **before** removing the containers;
stopping an agent alone keeps its last rules in place (fail closed):

```sh
# Stop the agent first, or its loop re-applies the rules within ten seconds.
docker stop dokploy-preview-firewall
# Same role and policy mount as the agent being removed:
#   manager:       -e PREVIEW_FIREWALL_ROLE=manager       -v /etc/dokploy/preview-firewall:/policy
#   worker-host:   -e PREVIEW_FIREWALL_ROLE=worker-host   -v dokploy-preview-worker_state:/policy
#   worker-engine: -e PREVIEW_FIREWALL_ROLE=worker-engine -v /etc/dokploy:/policy  (inside the worker)
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  -e PREVIEW_FIREWALL_ROLE=worker-engine -v /etc/dokploy:/policy \
  dokploy-preview-firewall:1 --uninstall
docker rm dokploy-preview-firewall
```

Use the worker-host line on the outer host: its policy lives in the worker
project's named volume, not in a host directory.

Then leave the Swarm from the worker (`docker swarm leave`) and remove the node
on the manager (`docker node rm <node>`). Never re-initialize the manager.

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
- [Mailpit SMTP settings](https://mailpit.axllent.org/docs/configuration/smtp/)

# terraform-provider-dokploy

Internal Terraform provider of the Flots Dokploy fork. It manages what lives in a
Dokploy instance (projects, environments, servers, services, domains, backups,
notifications, runner pools, settings) so that the Flots production Dokploy is
described in `Flots-app/iac-infra` and nothing is configured by hand.

It is not published to any registry. Its source address is
`registry.flots.app/flots-app/dokploy` (the host is never contacted): releases are
installed into a Terraform filesystem mirror (see "Install").

## Why a provider of our own

The community providers cover the upstream API only. The fork adds routers that
have no OpenAPI description (GitHub runner pools and nodes, OS updates,
firewalls), and its API drifts from upstream. The provider lives next to the
code it talks to, is tested against the fork's API shapes, and is released with
the same discipline.

## Configuration

Nothing secret belongs in a configuration, a plan or a state, so credentials are
read from the environment:

| Variable | Provider attribute | Content |
|---|---|---|
| `DOKPLOY_URL` | `url` | Dashboard URL, for example `https://dokploy.flots.app` |
| `DOKPLOY_API_KEY` | `api_key` | API key of a Dokploy user (sent as `x-api-key`) |
| `DOKPLOY_CUSTOM_HEADERS` | `custom_headers` | JSON object of extra headers, for the Cloudflare Access service token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) |

```hcl
terraform {
  required_providers {
    dokploy = {
      source  = "registry.flots.app/flots-app/dokploy"
      version = "0.1.0"
    }
  }
}

provider "dokploy" {}
```

## Secrets never reach the state

Dokploy stores secrets next to configuration: passwords, tokens, webhook URLs and
the whole environment text of a service. The provider keeps them out of the plan
and the state:

- **Secret inputs** are write-only attributes (`password_wo`, `access_key_wo`, ...,
  Terraform 1.11+). They are sent on creation, and when set again in the
  configuration. Bump the resource's `secrets_version` to resend them without any
  other change. They are never read back.
- **Environment text** of services and projects is split in two. `env` holds the
  public variables (stored in the state, so never a secret). `secret_env_keys`
  only names the secret variables: their values stay in Dokploy, and the provider
  copies each one over byte for byte whenever it rewrites the text. To create or
  rotate a secret, set it in `secret_env_wo` and bump `secret_env_wo_version`.
  `env_keys` reports the names Dokploy holds, so a variable added or removed by
  hand shows up as drift. Every variable must be declared in `env` or
  `secret_env_keys`; an undeclared one is removed on apply. Leave both out and the
  environment is not managed at all.

So a state can be read by anyone who may read the repository, and importing an
existing service never copies its secrets anywhere.

## Adopting existing objects

Every attribute that is not required is `Optional` and `Computed`: leave out what
you do not care about and Terraform adopts the value Dokploy reports. Import with
the Dokploy id of the object (`import { to = ..., id = "..." }`), then write the
minimal configuration until the plan is empty.

Free text that may embed credentials (an inline compose file, the content of a file
mount, a schedule script) is **opaque** until declared: when the configuration
leaves it out, the value Dokploy holds is never copied into the state, so importing
a service never leaks it. Declare it only when it holds no secret.

A plan that only touches the environment text does not rewrite the object: the first
apply after an import records the split in the state and writes nothing to Dokploy.

## Resources

| Resource | Import id |
|---|---|
| `dokploy_project`, `dokploy_environment` | `projectId`, `environmentId` |
| `dokploy_ssh_key` | `sshKeyId` (the private key is write-only) |
| `dokploy_server` | `serverId` (never runs setup, validation or monitoring) |
| `dokploy_registry`, `dokploy_destination` | `registryId`, `destinationId` |
| `dokploy_notification_{email,discord,slack,telegram,gotify,ntfy,mattermost,teams,lark,pushover,resend,custom}` | `notificationId` |
| `dokploy_application`, `dokploy_compose` | `applicationId`, `composeId` |
| `dokploy_postgres`, `dokploy_redis`, `dokploy_mysql`, `dokploy_mariadb`, `dokploy_mongo` | `<kind>Id` |
| `dokploy_domain`, `dokploy_mount`, `dokploy_schedule`, `dokploy_port`, `dokploy_redirect`, `dokploy_security` | their own id |
| `dokploy_backup` (databases, compose and the Dokploy web server), `dokploy_volume_backup` | `backupId`, `volumeBackupId` |
| `dokploy_web_server_settings` (singleton) | any value, the id is fixed to `web-server` |
| `dokploy_traefik_file` | `main`, `web_server`, `middlewares`, `file:<path>` or `file:<serverId>:<path>` |
| `dokploy_github_runner_pool`, `dokploy_github_runner_node` | `githubRunnerPoolId`, `githubRunnerNodeId` (machines are enrolled in the dashboard, then imported) |
| `dokploy_os_update_configuration`, `dokploy_firewall` | `osUpdateConfigurationId`, `firewallId` |

Data sources: `dokploy_github_provider` (the GitHub App, created by GitHub's manifest
flow from the dashboard), `dokploy_organization`, `dokploy_project`, `dokploy_server`.

Terraform never deploys anything: it configures. A service created through the
provider stays idle until Dokploy deploys it (git push webhook, schedule, or the
dashboard).

## Install

Releases are published by the `Terraform Provider` workflow when a tag
`terraform-provider-dokploy/vX.Y.Z` is pushed. The archives follow the layout of
a Terraform *packed* filesystem mirror, so `iac-infra` installs one with
`terraform/environments/dokploy/install-provider.sh`, which downloads it with
`gh`, checks it against the release's `SHA256SUMS` and copies it to
`~/.terraform.d/plugins/registry.flots.app/flots-app/dokploy/`. `terraform init`
then finds it without any CLI configuration.

## Develop

```bash
cd ops/terraform-provider-dokploy
go build ./...
TF_ACC_TERRAFORM_PATH="$(command -v terraform)" go test ./...   # needs Terraform 1.11+
```

The tests run the real Terraform binary against an in-memory fake of the Dokploy
API (`internal/provider/fakeapi_test.go`): create, update, import, drift, removal,
and an adoption test per resource that imports an object shaped like production
and requires an empty plan.

To try a local build against a real instance without releasing it, point
Terraform at the binary with a `dev_overrides` block in a CLI configuration file:

```hcl
# dev.tfrc, used with TF_CLI_CONFIG_FILE=dev.tfrc
provider_installation {
  dev_overrides {
    "registry.flots.app/flots-app/dokploy" = "/path/to/dir/with/the/binary"
  }
  direct {}
}
```

### Adding a resource

A resource is a declarative `Spec` registered from `init()`; see `project.go` and
`ssh_key.go`. `Spec.UseREST` wires create/read/update/delete on the REST facade;
override a hook for the odd procedure. Procedures without OpenAPI metadata (the
fork's runner pools, for example) go through the raw tRPC endpoint
(`Client.TRPCQuery` / `Client.TRPCMutate`). Secrets are `WriteOnly` fields, never
readable ones. Write the adoption test first: it is the acceptance criterion.

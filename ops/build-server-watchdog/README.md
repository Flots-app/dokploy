# Build server watchdog

A Dokploy **Scheduled Job → Dokploy Server** checks the existing Mac build
server every minute, independently of deployments. It uses Dokploy's stored SSH
key and Discord notification settings; credentials are never copied into files.
This adapter targets the existing Discord channel with **Build errors** enabled.
Other notification transports are not implemented by this operational script.

Two consecutive failed `docker info` checks open an incident. The watchdog sends
an alert, starts the existing default Colima VM if stopped, or restarts it when
running but Docker is unresponsive. A new Docker probe must succeed before a
recovery notification is sent. It never deletes VMs/volumes and never restarts a
Linux deployment server. Services already deployed on the VPS are unaffected.

Recovery is limited to three attempts, at least five minutes apart. Failed
delivery is retried on later checks, preserving delivery progress per channel.
Healthy checks are silent. Incidents, attempts, and pending notifications persist
in `state.json` across job/container restarts. A lost network connection is
reported from Dokploy, even if the Mac cannot execute the recovery command.

## Installation

Copy `run.mjs` and `state.mjs` into a persistent directory, for example
`/etc/dokploy/watchdogs/build-server`, visible inside the Dokploy container.
Create a root-readable `config.json` alongside them:

```json
{
  "serverId": "existing-build-server-id",
  "organizationId": "owning-organization-id",
  "dashboardUrl": "https://dokploy.example.com/dashboard/settings/servers"
}
```

Create one Dokploy Server scheduled job, cron `* * * * *`, with this script:

```sh
#!/bin/sh
set -eu
cd /app
flock -n -E 0 /etc/dokploy/watchdogs/build-server/run.lock \
  timeout 240 node /etc/dokploy/watchdogs/build-server/run.mjs \
  /etc/dokploy/watchdogs/build-server/config.json
```

`flock` prevents overlapping recovery, including manual schedule runs. SSH
handshakes, probes, recovery commands, notification requests, and the whole job
have time limits. Recovery budgets are committed before issuing commands.
Use the scheduled-job logs for execution diagnostics and `state.json` for
incident/delivery status. Schedule success means the check ran; an outage is
tracked by the incident and notified separately.

Pause the scheduled job in Dokploy during planned Colima maintenance. To remove
the monitor, delete that one scheduled job; leave the Homebrew Colima service in
place if automatic login startup is still desired. After three failed attempts,
restore Colima manually; the next successful check automatically clears the
incident. Do not erase the state file just to force additional restarts.

For a controlled outage test, first check that no builds are active or queued,
set `validation: true` in the config, stop Colima, and observe two scheduled
checks. Verify the unavailable/recovered Discord confirmations and a successful
Docker probe, then remove `validation`. Never stop the runtime server for this
test. Do not leave validation mode enabled.

## Tests and sources

`node --test ops/build-server-watchdog/state.test.mjs`

- [Dokploy scheduler](../../packages/server/src/utils/schedules/utils.ts)
- [Dokploy Discord transport](../../packages/server/src/utils/notifications/utils.ts)
- [Colima commands](https://colima.run/docs/commands/)
- [Discord Execute Webhook: wait confirms saving the message](https://discord.com/developers/docs/resources/webhook#execute-webhook)
- [Homebrew services: automatic startup at login](https://docs.brew.sh/Manpage#services-subcommand)

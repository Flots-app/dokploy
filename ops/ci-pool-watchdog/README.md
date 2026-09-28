# CI pool watchdog

A Dokploy **Scheduled Job → Dokploy Server** checks, every minute and from
outside the Mac, the pool that runs the Flots CI: the Lima VM `flots-ci-linux`,
the runner services inside it, and the macOS iOS runner on the host.

It exists because every CI alert used to run on that same pool. On 2026-09-27
the VM did not restart after a Mac restart; jobs queued on
`flots-mac-mini-parallel` without failing for almost 24 hours and nothing was
reported.

## What it checks

Over SSH to the Mac registered in Dokploy as the build server, reusing its
stored key:

- `limactl list` reports the VM `Running`;
- `systemctl is-active` is `active` for every unit in `runnerUnits`, inside the VM;
- a `Runner.Listener` process runs on the host (iOS runner), unless
  `iosRunner` is `false`.

An unreachable Mac is an outage too. The watchdog **only alerts**: launchd
already restarts the VM, and acting on the pool from here could kill CI jobs.

## Notifications

- `unavailable` after `failuresBeforeAlert` failed checks in a row (default 3,
  so a normal Mac restart stays silent), with the cause;
- `reminder` every `reminderHours` (default 6) while the outage lasts;
- `recovered` with the outage duration.

They go to the Dokploy Discord notifications of the organization that have
**Build errors** enabled, like the build-server watchdog. Webhooks are read from
Dokploy at run time and never copied. Undelivered messages are retried on the
next check. Healthy checks are silent.

## Installation

On the Dokploy host, copy the files, dereferencing `delivery.mjs` (a symlink to
the build-server watchdog's module in this repository):

```sh
install -d -m 0700 /etc/dokploy/watchdogs/ci-pool
cp -L ops/ci-pool-watchdog/{run,probe,state,delivery}.mjs /etc/dokploy/watchdogs/ci-pool/
chmod 0600 /etc/dokploy/watchdogs/ci-pool/*.mjs
```

Create `/etc/dokploy/watchdogs/ci-pool/config.json`, mode `0600`:

```json
{
  "serverId": "<Mac build server id>",
  "organizationId": "<owning organization id>",
  "instance": "flots-ci-linux",
  "runnerUnits": [
    "actions.runner.Flots-app-monorepo.macmini-m4-pool-1.service",
    "actions.runner.Flots-app-monorepo.macmini-m4-pool-2.service",
    "actions.runner.Flots-app-monorepo.macmini-m4-pool-3.service",
    "actions.runner.Flots-app-monorepo.macmini-m4-pool-4.service",
    "actions.runner.Flots-app.macmini-m4-linux.service"
  ],
  "iosRunner": true,
  "failuresBeforeAlert": 3,
  "reminderHours": 6
}
```

Create one Dokploy Server scheduled job, cron `* * * * *`:

```sh
#!/bin/sh
set -eu
cd /app
flock -n -E 0 /etc/dokploy/watchdogs/ci-pool/run.lock \
  timeout 120 node /etc/dokploy/watchdogs/ci-pool/run.mjs \
  /etc/dokploy/watchdogs/ci-pool/config.json
```

## Operating it

- Rehearse detection without sending anything with `"dryRun": true`: events are
  written to the job log as `[dry-run] <kind> : <message>`.
- `"validation": true` prefixes real messages with `[TEST CONTRÔLÉ]`; remove it
  after a controlled test.
- Pause the job during planned maintenance of the Mac or the VM.
- `state.json`, next to the config, holds the incident and pending messages. Do
  not delete it to silence an outage.

## Tests

`node --test ops/ci-pool-watchdog/*.test.mjs`

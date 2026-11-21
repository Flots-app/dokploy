package provider

// Trimmed copies of the production GitHub runner pool and its two machines, as
// githubRunner.overview returns them (secrets masked by the export). They keep
// the runtime fields (routing, rollouts, observed, ...) on purpose: the
// resources must ignore them so that plans stay empty.

const rnProdPoolJSON = `{
 "apiUrl": "https://api.github.com",
 "appId": null,
 "appInstallationId": null,
 "authType": "provider",
 "autonomyReserve": 2,
 "blacksmithOrganization": null,
 "classRouting": {},
 "createdAt": "2026-11-01T18:06:17.754Z",
 "description": "Flots-app organization runners. Label flots-dokploy until the switch from the Mac mini runners.",
 "failover": {
  "cooldownMinutes": 30,
  "interruptions": 2,
  "mode": "auto",
  "windowMinutes": 10
 },
 "fallbackChain": [],
 "fallbackLabels": [
  "ubuntu-24.04-arm"
 ],
 "fallbackUsage": {},
 "firewall": null,
 "githubId": "gQJXmATMu5eSTvtWni3ya",
 "githubRunnerPoolId": "wBwBrAbeesYNEQxOxY11D",
 "hasAppPrivateKey": false,
 "hasBillingToken": false,
 "hasBlacksmithToken": false,
 "hasToken": false,
 "jobClasses": [],
 "jobCompletedHook": null,
 "jobGuard": {
  "events": [
   "pull_request",
   "push",
   "workflow_dispatch"
  ],
  "refuseDependabot": true,
  "refuseForks": true,
  "repositories": [
   "Flots-app/monorepo",
   "Flots-app/runner-smoke",
   "Flots-app/iac-infra",
   "Flots-app/website",
   "Flots-app/github-action-ci-runner-router"
  ]
 },
 "jobStartedHook": null,
 "labels": [
  "flots-dokploy"
 ],
 "latestRunnerVersion": "2.338.2",
 "name": "Flots-app",
 "nextNodeId": "hm8kyU_BjlDAqDewZs1np",
 "organizationId": "H6kENwEnUToStDD2th03b",
 "owner": "Flots-app",
 "placement": "fastest",
 "repository": null,
 "reroutes": [
  {
   "createdAt": "2026-11-20T09:46:51.231Z",
   "githubRunnerPoolId": "wBwBrAbeesYNEQxOxY11D",
   "githubRunnerRerouteId": "9p-Oi5h7ZxiJTF1x9WZ10",
   "note": "Re-run, but its jobs ask for the pool labels directly: use the routing variable in runs-on",
   "repository": "Flots-app/monorepo",
   "runAttempt": 2,
   "runId": "44620433226",
   "status": "failed",
   "updatedAt": "2026-11-20T09:48:00.157Z",
   "workflow": "Pull Request Template"
  }
 ],
 "rerunInterruptedJobs": true,
 "rolloutPolicy": {
  "canary": true,
  "maxUnavailable": 1
 },
 "rollouts": {
  "runtime": {
   "canaryNodeId": "hm8kyU_BjlDAqDewZs1np",
   "error": null,
   "failedAt": null,
   "installedAt": "2026-11-14T18:08:44.529Z",
   "passedAt": "2026-11-14T18:18:49.295Z",
   "startedAt": "2026-11-14T18:08:30.295Z",
   "target": "18"
  }
 },
 "routing": {
  "attemptedAt": "2026-11-21T08:35:29.128Z",
  "error": null,
  "provider": null,
  "since": "2026-11-21T08:20:26.602Z",
  "syncedAt": "2026-11-21T08:35:29.128Z",
  "syncedValue": "[\"self-hosted\",\"flots-dokploy\"]",
  "target": "pool",
  "unavailableSince": null,
  "value": "[\"self-hosted\",\"flots-dokploy\"]",
  "variable": "DOKPLOY_RUNS_ON"
 },
 "routingVariable": "DOKPLOY_RUNS_ON",
 "runnerEnvKeys": [],
 "runnerGroup": "Default",
 "runnerVersion": null,
 "scope": "organization",
 "updatePolicy": {
  "auto": true,
  "window": null
 },
 "x64FallbackLabels": [
  "ubuntu-24.04"
 ],
 "x64Routing": {
  "attemptedAt": "2026-11-21T08:35:29.128Z",
  "error": null,
  "provider": null,
  "since": "2026-11-21T08:20:28.594Z",
  "syncedAt": "2026-11-21T08:35:29.128Z",
  "syncedValue": "[\"self-hosted\",\"flots-dokploy-x64\"]",
  "target": "pool",
  "unavailableSince": null,
  "value": "[\"self-hosted\",\"flots-dokploy-x64\"]",
  "variable": "DOKPLOY_RUNS_ON_X64"
 }
}`

const rnProdNodeM4JSON = `{
 "applied": {
  "bootScript": 3,
  "cpuPercent": 100,
  "cpus": 10,
  "envHash": "9a6037e59b80064e",
  "memoryBytes": 12884901888,
  "memoryPercent": 75,
  "rosetta": true,
  "runnerVersion": "2.338.2",
  "runtimeVersion": 10,
  "vmCreatedByDokploy": true,
  "vmDiskGb": 60
 },
 "benchmark": {
  "at": "2026-11-21T08:20:30.557Z",
  "cpuPercent": 100,
  "cpus": 10,
  "multi": 4785,
  "single": 812,
  "vmCpus": 10
 },
 "budget": {
  "cpus": 10,
  "memoryBytes": 12884901888
 },
 "cleanups": [
  {
   "at": "2026-11-21T08:23:12.127Z",
   "durationMs": 2099,
   "freeAfterBytes": 35742736384,
   "freeBeforeBytes": 35696549888,
   "freed": [
    {
     "bytes": 48062464,
     "count": 0,
     "kind": "volumes"
    }
   ],
   "hostFreeAfterBytes": 74186493952,
   "hostFreeBeforeBytes": 73894338560,
   "idle": "not-needed",
   "mode": "auto",
   "reached": false,
   "targetBytes": 37190071296,
   "trigger": "filling"
  }
 ],
 "cpuPercent": 100,
 "createdAt": "2026-11-01T18:06:43.686Z",
 "description": "Mac mini M4 (killians-mac-mini): the monorepo Linux CI since 2026-11-01.",
 "diskCleanupPercent": 90,
 "diskReserveGb": 15,
 "diskThresholds": {
  "host": {
   "cleanupBytes": 24510719590,
   "reserveBytes": 16106127360,
   "targetBytes": 36766079385
  },
  "vm": {
   "cleanupBytes": 8589934592,
   "reserveBytes": 3221225472,
   "targetBytes": 13958643712
  }
 },
 "drain": null,
 "enabled": true,
 "extraLabels": [],
 "firewall": null,
 "firewallStatus": null,
 "githubRunnerNodeId": "hm8kyU_BjlDAqDewZs1np",
 "githubRunnerPoolId": "wBwBrAbeesYNEQxOxY11D",
 "hasOwnKey": true,
 "health": null,
 "host": "100.115.98.81",
 "hostKeyFingerprint": "SHA256:W+wynJRAVcXJMTg6w62mHHWlsC3DAYJ3yJjqZCxXxqI",
 "keepAwake": true,
 "lastError": null,
 "lastPrunedAt": "2026-11-21T08:23:12.127Z",
 "lastSeenAt": "2026-11-21T08:44:29.427Z",
 "maxRunners": 3,
 "memoryPercent": 75,
 "name": "m4",
 "observed": {
  "admission": {
   "ok": true
  },
  "at": "2026-11-21T08:44:29.427Z",
  "host": {
   "arch": "arm64",
   "cpus": 10,
   "diskFreeBytes": 73966727168,
   "diskTotalBytes": 245107195904,
   "memoryBytes": 17179869184,
   "os": "macOS 27.2.1",
   "rosetta": true
  },
  "reachable": true,
  "runtime": {
   "runnerVersion": "2.338.2",
   "swapBytes": 4294963200,
   "version": 18
  },
  "slots": [
   {
    "job": null,
    "runnerId": 169977,
    "runnerName": "dkp-m4-1-41438d",
    "since": "2026-11-21T08:33:44.000Z",
    "slot": 1,
    "state": "idle"
   }
  ]
 },
 "operation": null,
 "organizationId": "H6kENwEnUToStDD2th03b",
 "os": {
  "checkedAt": "2026-11-21T08:20:05.994Z",
  "error": null,
  "guest": {
   "label": "Ubuntu 24.04",
   "message": "Ubuntu 24.04: 15 updates waiting, none for security. Install them with sudo apt upgrade, then reboot if asked, while no job runs.",
   "state": "updates",
   "supportEnds": "2029-05-31"
  },
  "host": {
   "label": "macOS 27.2.1",
   "message": "macOS 27.2.1, up to date.",
   "state": "current",
   "supportEnds": null
  }
 },
 "osReport": {
  "at": "2026-11-21T08:20:05.994Z",
  "guest": {
   "build": null,
   "id": "ubuntu",
   "kernel": "6.8.0-149-generic",
   "listsAt": "2026-11-19T00:16:59.000Z",
   "reboot": false,
   "security": 0,
   "updates": 15,
   "version": "24.04"
  },
  "host": {
   "build": "26B131",
   "id": "macos",
   "kernel": "27.2.0",
   "listsAt": null,
   "reboot": null,
   "security": 0,
   "updates": 0,
   "version": "27.2.1"
  }
 },
 "phase": "ready",
 "platform": "macos",
 "port": 22,
 "resolvedMaxRunners": 3,
 "runnerNamePrefix": "dkp-m4-",
 "runnerUpdate": {
  "deadline": null,
  "installed": "2.338.2",
  "latest": "2.338.2",
  "message": "actions/runner 2.338.2, the latest release",
  "state": "current"
 },
 "runtimeUpdatePending": false,
 "setup": {
  "arch": "arm64",
  "at": "2026-11-01T18:11:45.379Z",
  "fileVault": "off",
  "hostKeys": [
   "SHA256:rRJ43ebhkMXfPwGdDvCIMqJi+5uvGalSNtIRbloZHtE",
   "SHA256:W+wynJRAVcXJMTg6w62mHHWlsC3DAYJ3yJjqZCxXxqI",
   "SHA256:bTO0zL/qpU19nmkVJu1It4/6I3yrdLQdPUG4CGrbcYU"
  ],
  "hosts": [
   "100.115.98.81",
   "Killians-Mac-mini.local",
   "192.168.1.15"
  ],
  "keepAwake": true,
  "os": "macOS 26.6.2"
 },
 "sshKey": null,
 "sshKeyId": null,
 "sshKeyName": null,
 "sshKeyRotatedAt": "2026-11-14T10:48:17.078Z",
 "sshPublicKey": "<redacted:str>",
 "updatePolicy": null,
 "updateState": {
  "error": null,
  "errorAt": null,
  "inProgress": null,
  "requestedAt": null
 },
 "updates": {
  "auto": true,
  "description": "any time",
  "error": null,
  "inProgress": null,
  "inherited": true,
  "open": true,
  "osPatches": false,
  "patchError": null,
  "patchedAt": null,
  "requestedAt": null,
  "window": null
 },
 "username": "<redacted:str>",
 "vmDiskGb": 60,
 "vmName": "dokploy-runners",
 "x64Runners": 1
}`

const rnProdNodeM6JSON = `{
 "applied": {
  "bootScript": 3,
  "cpuPercent": 75,
  "cpus": 9,
  "envHash": "9a6037e59b80064e",
  "memoryBytes": 17179869184,
  "memoryPercent": 50,
  "runnerVersion": "2.338.2",
  "runtimeVersion": 11,
  "vmCreatedByDokploy": true,
  "vmDiskGb": 25
 },
 "benchmark": {
  "at": "2026-11-12T09:02:19.403Z",
  "cpuPercent": 75,
  "cpus": 9,
  "multi": 7359,
  "single": 1173,
  "vmCpus": 9
 },
 "budget": {
  "cpus": 9,
  "memoryBytes": 17179869184
 },
 "cleanups": [
  {
   "at": "2026-11-11T15:33:46.041Z",
   "durationMs": 729,
   "freeAfterBytes": 20757663744,
   "freeBeforeBytes": 20757663744,
   "freed": [],
   "hostFreeAfterBytes": 21984559104,
   "hostFreeBeforeBytes": 21983866880,
   "idle": "done",
   "mode": "auto",
   "reached": false,
   "targetBytes": 24883167232,
   "trigger": "low-disk"
  }
 ],
 "cpuPercent": 75,
 "createdAt": "2026-11-06T19:30:28.075Z",
 "description": "Mac mini M6 (macmini-de-erwan), next to the M4 in the fleet.",
 "diskCleanupPercent": 90,
 "diskReserveGb": 15,
 "diskThresholds": {
  "host": {
   "cleanupBytes": 24505476710,
   "reserveBytes": 16106127360,
   "targetBytes": 36758215065
  },
  "vm": null
 },
 "drain": null,
 "enabled": false,
 "extraLabels": [],
 "firewall": null,
 "firewallStatus": null,
 "githubRunnerNodeId": "2M1L0Vvfgb6HcUsKa7Inl",
 "githubRunnerPoolId": "wBwBrAbeesYNEQxOxY11D",
 "hasOwnKey": true,
 "health": null,
 "host": "100.119.26.24",
 "hostKeyFingerprint": "SHA256:fzJb2uBxQ0VzqAHyP2ogUzj8GjB7ngtTy9Z7tB3cVIo",
 "keepAwake": true,
 "lastError": "Unable to connect to m6 (100.119.26.24:22): Timed out while waiting for handshake",
 "lastPrunedAt": "2026-11-12T09:06:46.806Z",
 "lastSeenAt": "2026-11-21T08:32:14.352Z",
 "maxRunners": 1,
 "memoryPercent": 50,
 "name": "m6",
 "observed": {
  "admission": {
   "ok": true
  },
  "at": "2026-11-21T08:43:43.480Z",
  "host": {
   "arch": "arm64",
   "cpus": 12,
   "diskFreeBytes": 9071923200,
   "diskTotalBytes": 245054767104,
   "memoryBytes": 34359738368,
   "os": "macOS 27.0.1",
   "rosetta": true
  },
  "reachable": false,
  "runtime": {
   "runnerVersion": "2.338.2",
   "version": 11
  },
  "slots": []
 },
 "operation": null,
 "organizationId": "H6kENwEnUToStDD2th03b",
 "os": {
  "checkedAt": "2026-11-12T07:39:15.739Z",
  "error": null,
  "guest": {
   "label": "Ubuntu 24.04",
   "message": "Ubuntu 24.04: 27 updates waiting, none for security. Install them with sudo apt upgrade, then reboot if asked, while no job runs. The package lists date from 2026-11-11: run sudo apt update to see recent updates.",
   "state": "updates",
   "supportEnds": "2029-05-31"
  },
  "host": {
   "label": "macOS 27.0.1",
   "message": "macOS 27.0.1: 2 recommended updates waiting. Install them in System Settings \u203a General \u203a Software Update.",
   "state": "outdated",
   "supportEnds": null
  }
 },
 "osReport": {
  "at": "2026-11-12T07:39:15.739Z",
  "guest": {
   "build": null,
   "id": "ubuntu",
   "kernel": "6.8.0-147-generic",
   "listsAt": "2026-11-11T03:14:57.000Z",
   "reboot": false,
   "security": 0,
   "updates": 27,
   "version": "24.04"
  },
  "host": {
   "build": "26A434",
   "id": "macos",
   "kernel": "27.0.0",
   "listsAt": null,
   "reboot": null,
   "security": 2,
   "updates": 2,
   "version": "27.0.1"
  }
 },
 "phase": "stopped",
 "platform": "macos",
 "port": 22,
 "resolvedMaxRunners": 1,
 "runnerNamePrefix": "dkp-m6-",
 "runnerUpdate": {
  "deadline": null,
  "installed": "2.338.2",
  "latest": "2.338.2",
  "message": "actions/runner 2.338.2, the latest release",
  "state": "current"
 },
 "runtimeUpdatePending": true,
 "setup": {
  "arch": "arm64",
  "at": "2026-11-06T19:38:15.150Z",
  "fileVault": "off",
  "hostKeys": [
   "SHA256:b8GoK45fToxf4hE/3/0sKh9zJ3C8EDoyAEpRAy189Vs",
   "SHA256:fzJb2uBxQ0VzqAHyP2ogUzj8GjB7ngtTy9Z7tB3cVIo",
   "SHA256:NMfkueiZ/j9tGmDyWWDNtYb8o7QyHao9Q85pyMkAFqU"
  ],
  "hosts": [
   "100.119.26.24",
   "Macmini-de-Erwan.local",
   "192.168.1.199"
  ],
  "keepAwake": true,
  "os": "macOS 27.0.1"
 },
 "sshKey": null,
 "sshKeyId": null,
 "sshKeyName": null,
 "sshKeyRotatedAt": null,
 "sshPublicKey": "<redacted:str>",
 "updatePolicy": null,
 "updateState": null,
 "updates": {
  "auto": true,
  "description": "any time",
  "error": null,
  "inProgress": null,
  "inherited": true,
  "open": true,
  "osPatches": false,
  "patchError": null,
  "patchedAt": null,
  "requestedAt": null,
  "window": null
 },
 "username": "<redacted:str>",
 "vmDiskGb": 25,
 "vmName": "dokploy-runners",
 "x64Runners": 0
}`

# GitHub runners local lab

End-to-end test bench for **GitHub Runners** (Dokploy → GitHub Runners): one
Linux machine and one Mac, driven by a Dokploy development server, registering
real ephemeral runners on a throwaway GitHub repository or organization.

- `dokploy-runner-linux`: a plain Ubuntu Lima VM reachable on `127.0.0.1:22231`
  as `dokploy`. It stands for a "Linux VM" runner machine: Dokploy installs
  Docker, the runtime and the budget itself.
- The Mac itself, reached through an `sshd` started by the current user on
  `127.0.0.1:22230` only, with the lab key only. Remote Login and the system
  `sshd` are left untouched. Dokploy creates the runner VM
  `dokploy-runners-e2e` on it, exactly as on a real Mac mini.

## Prerequisites

- Lima 2.0 or newer, OpenSSH client tools, about 10 GiB of free disk;
- a Dokploy development server with its own database (see
  `dev/compose-build-server-lab/README.md`);
- a throwaway private repository containing `workflow/runner-e2e.yml` under
  `.github/workflows/`, and a fine-grained token limited to it with
  "Administration: read and write" and "Actions: read and write". For an
  organization pool, the token needs the organization permission "Self-hosted
  runners: read and write" instead of Administration, and the pool should use a
  runner group restricted to the test repository.

Never point the pool at labels real workflows use.

## Lifecycle

```bash
cd dev/github-runners-lab
make up       # Linux VM + local sshd, prints the connection values
make down     # stop the sshd and both VMs
make destroy  # delete both VMs and the lab key
```

In Dokploy: add the SSH key printed by `make up`, create a pool for the test
repository (label `dokploy-e2e`), then add both machines.

## Scenarios

Dispatch jobs with
`gh workflow run runner-e2e.yml -f seconds=60 -f indexes='[1,2]' -f machine=dokploy-<machine>`
(`machine=dokploy-e2e` lets the pool pick).

| Scenario | Expected |
| --- | --- |
| Provision Linux / Mac | Linux ready in about a minute (Docker included); the Mac VM is created, sized to the budget, and ready in about a minute |
| Job on Linux at 50% CPU of 2 CPUs | `nproc=1`, `cpu.max=100000 100000`, `cpuset` pinned, the job's own `docker run` sees `nproc=1` |
| Job on the Mac | `nproc` equals the VM CPUs, workspace clean, tool cache and home persistent |
| After every job | the slot gets a new runner (ephemeral), the job is recorded with its duration |
| Disable, wait | idle runners leave at once, running jobs finish, the machine stops (the Mac VM shuts down) |
| Disable, wait at most N minutes | still-running jobs are interrupted at the deadline |
| Disable, interrupt now | jobs end with "The runner has received a shutdown signal" within seconds; they are re-run on the other machines |
| Budget change on Linux | slice limits change live, the running job continues |
| Budget change on the Mac | the VM restarts with the new size once its jobs finish |
| Concurrency or labels change | idle runners are recycled, busy ones are kept |
| `systemctl kill -s SIGKILL dokploy-runner@1` during a job | the slot is re-armed at once; the run is cancelled once nothing else runs, then its failed jobs are re-run elsewhere |
| `limactl stop --force dokploy-runner-linux` during a job | the machine is unreachable within seconds, its job is declared lost after two minutes and re-run on the Mac |
| Restart the Linux VM | Lima regenerates the guest host key: Dokploy refuses it until it is accepted under "SSH host key", then the machine rejoins |
| Restart Dokploy while draining | the drain resumes and completes |
| Remove with uninstall | runners unregistered, runtime, account, units and Docker `cgroup-parent` removed; a VM created by Dokploy is deleted, an adopted one is kept |

## Troubleshooting

- The anonymous GitHub API quota is 60 calls per hour per public IP. Dokploy
  never uses it on a schedule, but other tools on the same network may.
- Lima forwards SSH through vsock: a guest firewall does not cut Dokploy off.
  Use `limactl stop --force` to simulate a dead machine.

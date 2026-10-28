import { budgetWarnings, formatBytes, formatCpus, vmSize } from "./budget";
import { diskThresholds, freeAtUsage } from "./disk";
import { LIMA_VERSION } from "./macos";
import type { LinuxFacts, MacStatus } from "./probe";
import { RUNTIME_VERSION } from "./runtime";

export type NodeCheckStatus = "pass" | "warn" | "fail";

export interface NodeCheck {
	id: string;
	label: string;
	status: NodeCheckStatus;
	message: string;
}

const GiB = 1024 ** 3;

export interface CheckSettings {
	vmName: string;
	vmDiskGb: number;
	diskReserveGb: number;
	diskCleanupPercent: number;
	cpuPercent: number;
	memoryPercent: number;
	maxRunners: number;
}

const check = (
	id: string,
	label: string,
	status: NodeCheckStatus,
	message: string,
): NodeCheck => ({ id, label, status, message });

const budgetChecks = (
	platform: "linux" | "macos",
	host: { cpus: number; memoryBytes: number },
	settings: CheckSettings,
) =>
	budgetWarnings(platform, host, settings).map((message, index) =>
		check(`budget-${index}`, "Budget", "warn", message),
	);

/**
 * The cleanup percentage of a small disk can leave less free space than the
 * reserve: caches would then only go once jobs already stop starting.
 */
const cleanupBelowReserve = (
	totalBytes: number | null | undefined,
	settings: CheckSettings,
	disk: string,
): NodeCheck[] => {
	if (!totalBytes) return [];
	const free = freeAtUsage(totalBytes, settings.diskCleanupPercent);
	if (free > settings.diskReserveGb * GiB) return [];
	return [
		check(
			"disk-cleanup",
			"Disk cleanup",
			"warn",
			`${settings.diskCleanupPercent}% of this ${formatBytes(totalBytes)} ${disk} leaves ${formatBytes(free)} free, not more than the ${settings.diskReserveGb} GiB reserve: caches are only cleaned once new jobs stop starting. Lower the percentage or the reserve.`,
		),
	];
};

export const linuxChecks = (
	facts: LinuxFacts,
	settings: CheckSettings,
): NodeCheck[] => {
	const checks: NodeCheck[] = [];
	checks.push(
		facts.kernel === "Linux"
			? check(
					"platform",
					"Platform",
					"pass",
					`${facts.distro} ${facts.distroVersion} (${facts.arch})`,
				)
			: check(
					"platform",
					"Platform",
					"fail",
					`Unsupported system: ${facts.kernel}`,
				),
	);
	checks.push(
		["x86_64", "amd64", "aarch64", "arm64"].includes(facts.arch)
			? check("arch", "CPU architecture", "pass", facts.arch)
			: check(
					"arch",
					"CPU architecture",
					"fail",
					`GitHub publishes no runner for ${facts.arch}`,
				),
	);
	checks.push(
		facts.root || facts.sudo
			? check(
					"privileges",
					"Privileges",
					"pass",
					facts.root ? "Connected as root" : "Passwordless sudo available",
				)
			: check(
					"privileges",
					"Privileges",
					"fail",
					"The SSH user needs to be root or to have passwordless sudo",
				),
	);
	checks.push(
		facts.systemd
			? check("systemd", "systemd", "pass", "Runners run as systemd services")
			: check("systemd", "systemd", "fail", "systemd is required"),
	);
	checks.push(
		facts.cgroupV2
			? check(
					"cgroup",
					"Resource limits",
					"pass",
					"cgroup v2: the CPU and memory budget is enforced by the kernel",
				)
			: check(
					"cgroup",
					"Resource limits",
					"fail",
					"cgroup v2 is required to enforce the CPU and memory budget",
				),
	);
	if (facts.docker.swarm === "active" || facts.docker.swarm === "pending") {
		checks.push(
			check(
				"dedicated",
				"Dedicated machine",
				"fail",
				"This machine is a Docker Swarm node (a Dokploy server?). Jobs get Docker access, which is root on the host: use a dedicated machine.",
			),
		);
	} else if ((facts.docker.containers ?? 0) > 0) {
		checks.push(
			check(
				"dedicated",
				"Dedicated machine",
				"warn",
				`${facts.docker.containers} Docker containers already exist. Jobs share this Docker daemon, its containers move to the runner budget after a restart, and unused Docker data is pruned: images, build cache and volumes no container uses.`,
			),
		);
	} else {
		checks.push(
			check(
				"dedicated",
				"Dedicated machine",
				"pass",
				facts.docker.present
					? "Docker has no container: the machine looks dedicated"
					: facts.apt
						? "Docker will be installed"
						: "Docker is missing: jobs will not be able to use it",
			),
		);
	}
	checks.push(
		facts.apt
			? check(
					"packages",
					"Packages",
					"pass",
					"Missing packages are installed with apt",
				)
			: check(
					"packages",
					"Packages",
					"warn",
					"No apt-get: curl, tar, jq, git and Docker must already be installed",
				),
	);
	checks.push(
		facts.cpus >= 2 && facts.memoryBytes >= 4 * GiB
			? check(
					"capacity",
					"Capacity",
					"pass",
					`${formatCpus(facts.cpus)}, ${formatBytes(facts.memoryBytes)} memory`,
				)
			: check(
					"capacity",
					"Capacity",
					"warn",
					`${formatCpus(facts.cpus)} and ${formatBytes(facts.memoryBytes)} is little for CI jobs`,
				),
	);
	const free = facts.diskFreeBytes ?? 0;
	const wanted =
		(facts.diskTotalBytes
			? diskThresholds(facts.diskTotalBytes, settings).cleanupBytes
			: settings.diskReserveGb * GiB) +
		10 * GiB;
	checks.push(
		free >= wanted
			? check("disk", "Disk", "pass", `${formatBytes(free)} free`)
			: check(
					"disk",
					"Disk",
					free < 5 * GiB ? "fail" : "warn",
					`${formatBytes(free)} free: little room for caches, which are cleaned once the disk is ${settings.diskCleanupPercent}% full; no job starts below the ${settings.diskReserveGb} GiB reserve`,
				),
	);
	checks.push(...cleanupBelowReserve(facts.diskTotalBytes, settings, "disk"));
	checks.push(
		facts.githubReachable
			? check("network", "GitHub", "pass", "github.com is reachable")
			: check(
					"network",
					"GitHub",
					"fail",
					"The machine cannot reach github.com",
				),
	);
	if (facts.runtimeVersion > 0) {
		checks.push(
			check(
				"runtime",
				"Existing runtime",
				facts.runtimeVersion > RUNTIME_VERSION ? "fail" : "pass",
				facts.runtimeVersion > RUNTIME_VERSION
					? `A newer Dokploy runner runtime (v${facts.runtimeVersion}) is installed; update Dokploy first`
					: `Dokploy runner runtime v${facts.runtimeVersion} already installed: it will be updated in place`,
			),
		);
	}
	checks.push(
		...budgetChecks(
			"linux",
			{ cpus: facts.cpus, memoryBytes: facts.memoryBytes },
			settings,
		),
	);
	return checks;
};

/** What the setup script of an enrolled Mac configures, checked as the Mac reports it. */
const macSetupChecks = (setup: MacStatus["setup"]): NodeCheck[] => {
	if (!setup) return [];
	const checks: NodeCheck[] = [];
	checks.push(
		setup.admin
			? check(
					"account",
					"Account",
					"warn",
					"Dokploy logs in with an administrator account: use the dokploy-manager account the setup script creates, which needs no admin rights",
				)
			: check(
					"account",
					"Account",
					"pass",
					"Standard account, no admin rights",
				),
	);
	if (setup.sleepMinutes !== 0) {
		checks.push(
			check(
				"power",
				"Power",
				"warn",
				`The Mac sleeps after ${setup.sleepMinutes ?? "some"} minute(s) without activity: its runners go offline meanwhile. The setup script keeps it awake.`,
			),
		);
	}
	if (setup.fileVault) {
		checks.push(
			check(
				"filevault",
				"FileVault",
				"warn",
				"FileVault is on: after a power loss the Mac waits for someone to unlock it. Restart it with sudo fdesetup authrestart.",
			),
		);
	}
	checks.push(
		setup.bootDaemon
			? check(
					"boot",
					"Restart",
					"pass",
					"The runner VM starts again after a reboot",
				)
			: check(
					"boot",
					"Restart",
					"warn",
					"After a reboot the VM only starts once Dokploy reaches the Mac: the setup script installs a boot daemon that does it right away",
				),
	);
	return checks;
};

export const macChecks = (
	status: MacStatus,
	settings: CheckSettings,
): NodeCheck[] => {
	const checks: NodeCheck[] = [];
	if (!status.host) {
		return [
			check("platform", "Platform", "fail", "Unable to read the Mac facts"),
		];
	}
	checks.push(
		check(
			"platform",
			"Platform",
			"pass",
			`macOS ${status.host.version} (${status.host.arch}), ${formatCpus(status.host.cpus)}, ${formatBytes(status.host.memoryBytes)}`,
		),
	);
	checks.push(
		status.limaManaged && status.limaVersion === LIMA_VERSION
			? check(
					"lima",
					"Lima",
					"pass",
					`Lima ${status.limaVersion}, installed by Dokploy`,
				)
			: check(
					"lima",
					"Lima",
					"pass",
					`Dokploy installs Lima ${LIMA_VERSION} for this account (verified download, no Homebrew needed)`,
				),
	);
	checks.push(...macSetupChecks(status.setup));
	const size = vmSize(status.host, settings);
	if (status.vm.status === "missing") {
		checks.push(
			check(
				"vm",
				"Runner VM",
				"pass",
				`VM "${settings.vmName}" will be created: ${formatCpus(size.cpus)}, ${formatBytes(size.memoryBytes)}, ${settings.vmDiskGb} GiB disk (Ubuntu 24.04, no host mount)`,
			),
		);
	} else {
		checks.push(
			check(
				"vm",
				"Runner VM",
				status.vm.type && status.vm.type !== "vz" ? "warn" : "pass",
				`Existing VM "${settings.vmName}" (${status.vm.status}, ${status.vm.cpus ?? "?"} CPUs, ${status.vm.memoryBytes ? formatBytes(status.vm.memoryBytes) : "?"}) is adopted: the runtime is installed inside, it is resized to the budget at its next restart, and it is never deleted by Dokploy.`,
			),
		);
	}
	const free = status.disk?.freeBytes ?? 0;
	const needed =
		(status.disk?.totalBytes
			? diskThresholds(status.disk.totalBytes, settings).cleanupBytes
			: settings.diskReserveGb * GiB) +
		(status.vm.status === "missing" ? settings.vmDiskGb * GiB : 0);
	checks.push(
		free >= needed
			? check("disk", "Disk", "pass", `${formatBytes(free)} free on the Mac`)
			: check(
					"disk",
					"Disk",
					free < 10 * GiB ? "fail" : "warn",
					`${formatBytes(free)} free on the Mac; the VM disk can grow to ${settings.vmDiskGb} GiB, its caches are cleaned once the Mac disk is ${settings.diskCleanupPercent}% full, and no job starts below the ${settings.diskReserveGb} GiB reserve`,
				),
	);
	checks.push(
		...cleanupBelowReserve(status.disk?.totalBytes, settings, "Mac disk"),
	);
	checks.push(
		status.githubReachable
			? check("network", "GitHub", "pass", "github.com is reachable")
			: check("network", "GitHub", "fail", "The Mac cannot reach github.com"),
	);
	checks.push(...budgetChecks("macos", status.host, settings));
	return checks;
};

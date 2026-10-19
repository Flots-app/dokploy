import { budgetWarnings, formatBytes, formatCpus, vmSize } from "./budget";
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
	diskCleanupGb: number;
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

export const versionAtLeast = (version: string | null, minimum: string) => {
	if (!version) return false;
	const parts = version.replace(/^v/, "").split(/[.-]/).map(Number);
	const wanted = minimum.split(".").map(Number);
	for (let index = 0; index < wanted.length; index++) {
		const value = parts[index] ?? 0;
		const target = wanted[index] ?? 0;
		if (Number.isNaN(value)) return false;
		if (value !== target) return value > target;
	}
	return true;
};

const budgetChecks = (
	platform: "linux" | "macos",
	host: { cpus: number; memoryBytes: number },
	settings: CheckSettings,
) =>
	budgetWarnings(platform, host, settings).map((message, index) =>
		check(`budget-${index}`, "Budget", "warn", message),
	);

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
				`${facts.docker.containers} Docker containers already exist. Jobs share this Docker daemon, its containers move to the runner budget after a restart, and unused Docker data is pruned.`,
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
	const wanted = (settings.diskCleanupGb + 10) * GiB;
	checks.push(
		free >= wanted
			? check("disk", "Disk", "pass", `${formatBytes(free)} free`)
			: check(
					"disk",
					"Disk",
					free < 5 * GiB ? "fail" : "warn",
					`${formatBytes(free)} free: little room for caches, which are trimmed below ${settings.diskCleanupGb} GiB free; no job starts below the ${settings.diskReserveGb} GiB reserve`,
				),
	);
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

const MIN_LIMA_VERSION = "1.0.0";

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
	if (!status.limaVersion) {
		checks.push(
			check(
				"lima",
				"Lima",
				"fail",
				"Lima is not installed for this user. On the Mac: brew install lima",
			),
		);
	} else if (!versionAtLeast(status.limaVersion, MIN_LIMA_VERSION)) {
		checks.push(
			check(
				"lima",
				"Lima",
				"fail",
				`Lima ${status.limaVersion} is too old: ${MIN_LIMA_VERSION} or later is required (brew upgrade lima)`,
			),
		);
	} else {
		checks.push(check("lima", "Lima", "pass", `Lima ${status.limaVersion}`));
	}
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
		(settings.diskCleanupGb +
			(status.vm.status === "missing" ? settings.vmDiskGb : 0)) *
		GiB;
	checks.push(
		free >= needed
			? check("disk", "Disk", "pass", `${formatBytes(free)} free on the Mac`)
			: check(
					"disk",
					"Disk",
					free < 10 * GiB ? "fail" : "warn",
					`${formatBytes(free)} free on the Mac; the VM disk can grow to ${settings.vmDiskGb} GiB, its caches are trimmed while the Mac has less than ${settings.diskCleanupGb} GiB free, and no job starts below the ${settings.diskReserveGb} GiB reserve`,
				),
	);
	checks.push(
		status.githubReachable
			? check("network", "GitHub", "pass", "github.com is reachable")
			: check("network", "GitHub", "fail", "The Mac cannot reach github.com"),
	);
	checks.push(...budgetChecks("macos", status.host, settings));
	return checks;
};

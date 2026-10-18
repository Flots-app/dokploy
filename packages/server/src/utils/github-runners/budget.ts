const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export interface HostCapacity {
	cpus: number;
	memoryBytes: number;
}

export interface BudgetPercent {
	cpuPercent: number;
	memoryPercent: number;
}

/**
 * Limits of the systemd slice holding every runner process and job container on
 * Linux. Jobs share the whole budget without any per-job cap, so a lone job runs
 * at the full speed the budget allows.
 */
export interface SliceLimits {
	/** systemd CPUQuota in percent of one CPU (560 = 5.6 CPUs); null removes the limit. */
	cpuQuotaPercent: number | null;
	/**
	 * CPUs the jobs run on (systemd AllowedCPUs), so `nproc` and build tools see
	 * the budget instead of every host CPU and do not oversubscribe the quota.
	 * The first CPUs, which also serve interrupts, stay with the host.
	 */
	allowedCpus: string | null;
	memoryMaxBytes: number | null;
	cpus: number;
	memoryBytes: number;
}

/** Size of the Lima VM holding the runners on macOS. */
export interface VmSize {
	cpus: number;
	memoryBytes: number;
	/** Value passed to `limactl --memory`, in GiB. */
	memoryGiB: string;
}

export const MIN_VM_MEMORY_BYTES = 2 * GiB;

/** Per-job share used to size "auto" concurrency: 2 CPUs and 3 GiB. */
const JOB_CPUS = 2;
const JOB_MEMORY_BYTES = 3 * GiB;

export const sliceLimits = (
	host: HostCapacity,
	budget: BudgetPercent,
): SliceLimits => {
	const fullCpu = budget.cpuPercent >= 100;
	const fullMemory = budget.memoryPercent >= 100;
	const cpus = (host.cpus * budget.cpuPercent) / 100;
	const pinned = Math.min(host.cpus, Math.max(1, Math.ceil(cpus)));
	const memoryBytes =
		Math.floor((host.memoryBytes * budget.memoryPercent) / 100 / MiB) * MiB;
	return {
		cpuQuotaPercent: fullCpu ? null : Math.max(10, Math.round(cpus * 100)),
		allowedCpus:
			fullCpu || pinned >= host.cpus
				? null
				: pinned === 1
					? String(host.cpus - 1)
					: `${host.cpus - pinned}-${host.cpus - 1}`,
		memoryMaxBytes: fullMemory ? null : memoryBytes,
		cpus: fullCpu ? host.cpus : Math.round(cpus * 10) / 10,
		memoryBytes: fullMemory ? host.memoryBytes : memoryBytes,
	};
};

export const vmSize = (host: HostCapacity, budget: BudgetPercent): VmSize => {
	const cpus = Math.min(
		host.cpus,
		Math.max(1, Math.round((host.cpus * budget.cpuPercent) / 100)),
	);
	// Quarter-GiB steps keep the value exact for limactl's float flag.
	const quarters = Math.floor(
		(host.memoryBytes * budget.memoryPercent) / 100 / (GiB / 4),
	);
	const memoryBytes = Math.max(MIN_VM_MEMORY_BYTES, (quarters * GiB) / 4);
	return {
		cpus,
		memoryBytes,
		memoryGiB: String(memoryBytes / GiB),
	};
};

/** CPUs and memory the runners of a machine get, whatever the platform. */
export const effectiveBudget = (
	platform: "linux" | "macos",
	host: HostCapacity,
	budget: BudgetPercent,
): HostCapacity => {
	const size =
		platform === "macos" ? vmSize(host, budget) : sliceLimits(host, budget);
	return { cpus: size.cpus, memoryBytes: size.memoryBytes };
};

/**
 * As many concurrent jobs as the budget holds at 2 CPUs and 3 GiB each: more
 * would only make every job slower, fewer would leave capacity unused.
 */
export const autoMaxRunners = (budget: HostCapacity) =>
	Math.min(
		32,
		Math.max(
			1,
			Math.floor(
				Math.min(budget.cpus / JOB_CPUS, budget.memoryBytes / JOB_MEMORY_BYTES),
			),
		),
	);

/** maxRunners 0 means "auto": derived from the budget, then from host facts once known. */
export const resolveMaxRunners = (
	maxRunners: number,
	platform: "linux" | "macos",
	host: HostCapacity | null | undefined,
	budget: BudgetPercent,
) => {
	if (maxRunners > 0) return maxRunners;
	if (!host) return 1;
	return autoMaxRunners(effectiveBudget(platform, host, budget));
};

export const budgetWarnings = (
	platform: "linux" | "macos",
	host: HostCapacity,
	budget: BudgetPercent & { maxRunners: number },
): string[] => {
	const warnings: string[] = [];
	const effective = effectiveBudget(platform, host, budget);
	const runners = resolveMaxRunners(budget.maxRunners, platform, host, budget);
	const leftForHost = host.memoryBytes - effective.memoryBytes;
	if (platform === "macos" && leftForHost < 4 * GiB) {
		warnings.push(
			`Only ${formatBytes(Math.max(0, leftForHost))} of memory stay for macOS and your own work.`,
		);
	}
	if (effective.memoryBytes / runners < 2 * GiB) {
		warnings.push(
			`${jobs(runners)} ${formatBytes(effective.memoryBytes)}: less than 2 GiB each.`,
		);
	}
	if (effective.cpus / runners < 1) {
		warnings.push(
			`${jobs(runners)} ${formatCpus(effective.cpus)}: less than one each.`,
		);
	}
	return warnings;
};

/** "1 CPU", "1.4 CPUs", "8 CPUs". */
export const formatCpus = (cpus: number) =>
	`${cpus} CPU${cpus === 1 ? "" : "s"}`;

/** CPUs the runners are pinned to: "CPU 3" or "CPUs 2-7". */
export const formatCpuList = (list: string) =>
	`${list.includes("-") ? "CPUs" : "CPU"} ${list}`;

const jobs = (count: number) =>
	count === 1 ? "1 concurrent job gets" : `${count} concurrent jobs share`;

export const formatBytes = (bytes: number) => {
	if (bytes >= GiB) return `${Math.round((bytes / GiB) * 10) / 10} GiB`;
	return `${Math.round(bytes / MiB)} MiB`;
};

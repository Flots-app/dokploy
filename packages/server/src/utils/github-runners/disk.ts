/**
 * Disk housekeeping of a runner machine, like the kubelet image garbage
 * collector: caches grow freely until the disk is fuller than the cleanup
 * threshold (a percentage of its size, like the kubelet's
 * imageGCHighThresholdPercent), then `runnerctl gc` removes the least recently
 * used ones until the target is free again. Below the reserve no new job starts.
 */
const GiB = 1024 ** 3;

/** Inside the macOS VM: below this the runtime refuses new jobs whatever the host has. */
export const VM_MIN_FREE_BYTES = 3 * GiB;

/** How far ahead the fill rate is projected, and over which past window. */
export const FILL_HORIZON_MS = 10 * 60_000;
const FILL_WINDOW_MS = 10 * 60_000;
const MIN_HISTORY_MS = 3 * 60_000;
const MIN_SAMPLES = 4;

/** Retry delays: after a cleanup that reached its target, and after one that did not. */
const RETRY_AFTER_REACHED_MS = 2 * 60_000;
const RETRY_AFTER_MISSED_MS = 10 * 60_000;
/** Nothing was left to remove: the disk is full of something else. */
const RETRY_AFTER_EMPTY_MS = 30 * 60_000;
const RETRY_WHEN_IDLE_MS = 30_000;

export interface DiskThresholds {
	/** No new job starts below. */
	reserveBytes: number;
	/** The least recently used caches are removed below. */
	cleanupBytes: number;
	/** A cleanup stops once this much is free. */
	targetBytes: number;
}

/** What a cleanup frees above its threshold: 5% of the disk, between 5 and 25 GiB. */
const headroom = (totalBytes: number) =>
	Math.min(25 * GiB, Math.max(5 * GiB, Math.round(totalBytes * 0.05)));

/** Free space left on a disk of this size once it is `percent` full. */
export const freeAtUsage = (totalBytes: number, percent: number) =>
	Math.round((totalBytes * (100 - percent)) / 100);

/**
 * Thresholds of the machine disk (the Mac volume for a Mac), from its settings.
 * The cleanup never starts later than the reserve, whatever the percentage.
 */
export const diskThresholds = (
	totalBytes: number,
	settings: { diskReserveGb: number; diskCleanupPercent: number },
): DiskThresholds => {
	const reserveBytes = settings.diskReserveGb * GiB;
	const cleanupBytes = Math.max(
		freeAtUsage(totalBytes, settings.diskCleanupPercent),
		reserveBytes,
	);
	return {
		reserveBytes,
		cleanupBytes,
		targetBytes: cleanupBytes + headroom(totalBytes),
	};
};

/**
 * The macOS VM disk only holds runner data: the same percentage, with a floor
 * that keeps room above the VM reserve on a small disk.
 */
export const vmDiskThresholds = (
	totalBytes: number,
	diskCleanupPercent: number,
): DiskThresholds => {
	const cleanupBytes = Math.max(
		VM_MIN_FREE_BYTES + 5 * GiB,
		freeAtUsage(totalBytes, diskCleanupPercent),
	);
	return {
		reserveBytes: VM_MIN_FREE_BYTES,
		cleanupBytes,
		targetBytes: cleanupBytes + headroom(totalBytes),
	};
};

export interface DiskSample {
	at: number;
	freeBytes: number;
}

/** Keeps the samples the fill rate needs. */
export const trimSamples = (samples: DiskSample[], now: number) =>
	samples.filter((sample) => now - sample.at <= FILL_WINDOW_MS);

/**
 * Bytes per millisecond the disk fills at over the last minutes (negative while
 * it empties), by least squares; null without enough history.
 */
export const fillRate = (samples: DiskSample[], now: number): number | null => {
	const recent = trimSamples(samples, now);
	const first = recent[0];
	if (
		!first ||
		recent.length < MIN_SAMPLES ||
		now - first.at < MIN_HISTORY_MS
	) {
		return null;
	}
	const meanAt =
		recent.reduce((sum, sample) => sum + (sample.at - first.at), 0) /
		recent.length;
	const meanFree =
		recent.reduce((sum, sample) => sum + sample.freeBytes, 0) / recent.length;
	let covariance = 0;
	let variance = 0;
	for (const sample of recent) {
		const x = sample.at - first.at - meanAt;
		covariance += x * (sample.freeBytes - meanFree);
		variance += x * x;
	}
	return variance === 0 ? null : -covariance / variance;
};

export type CleanupTrigger = "low-disk" | "filling";

export interface DiskPressure {
	trigger: CleanupTrigger;
	/** Free space the cleanup aims for. */
	targetBytes: number;
	/** Below this after the cleanup of unused caches, warm caches go too. */
	thresholdBytes: number;
	/** What the jobs are expected to write over the horizon. */
	expectedBytes: number;
}

/**
 * Whether a disk needs a cleanup: free space below the threshold, or expected
 * below it within the horizon at the current fill rate. Both keep room for what
 * the jobs are expected to write meanwhile. Below the threshold, the cleanup
 * goes up to the target; ahead of it, only up to the threshold: a projection
 * (often a burst of pulls and builds, or the Mac's own writes) is no reason to
 * remove more caches than it needs, and the disk going low still gets the full
 * cleanup.
 */
export const diskPressure = (
	freeBytes: number,
	totalBytes: number,
	thresholds: DiskThresholds,
	rate: number | null,
): DiskPressure | null => {
	const expectedBytes =
		rate !== null && rate > 0 ? Math.round(rate * FILL_HORIZON_MS) : 0;
	const pressure = (trigger: CleanupTrigger, goalBytes: number) => ({
		trigger,
		targetBytes: Math.min(totalBytes, goalBytes + expectedBytes),
		thresholdBytes: thresholds.cleanupBytes,
		expectedBytes,
	});
	if (freeBytes < thresholds.cleanupBytes) {
		return pressure("low-disk", thresholds.targetBytes);
	}
	if (
		expectedBytes > 0 &&
		freeBytes - expectedBytes < thresholds.cleanupBytes
	) {
		return pressure("filling", thresholds.cleanupBytes);
	}
	return null;
};

/**
 * Folds the pressure of the Mac volume into the VM disk: whatever the VM frees
 * goes back to the Mac (the guest discards deleted blocks of its sparse disk),
 * so the VM aims for its own goal plus what the Mac is missing. The threshold
 * maps the same way, and lies below the VM's free space while no disk is below
 * its own: the step that removes the caches in use must not run because the
 * VM wrote a few bytes since it was measured.
 */
export const vmCleanupGoal = (
	vm: { freeBytes: number; totalBytes: number; pressure: DiskPressure | null },
	mac: { freeBytes: number; pressure: DiskPressure | null },
): DiskPressure | null => {
	const disks = [
		{ pressure: vm.pressure, freeBytes: vm.freeBytes },
		{ pressure: mac.pressure, freeBytes: mac.freeBytes },
	].flatMap(({ pressure, freeBytes }) =>
		pressure ? [{ pressure, freeBytes }] : [],
	);
	if (disks.length === 0) return null;
	/** What the disk furthest from a goal misses (negative when all are past it). */
	const missing = (goal: (pressure: DiskPressure) => number) =>
		Math.max(
			...disks.map(({ pressure, freeBytes }) => goal(pressure) - freeBytes),
		);
	const inVm = (bytes: number) =>
		Math.min(vm.totalBytes, Math.max(0, vm.freeBytes + bytes));
	return {
		trigger: disks.some(({ pressure }) => pressure.trigger === "low-disk")
			? "low-disk"
			: "filling",
		targetBytes: inVm(
			Math.max(
				0,
				missing((pressure) => pressure.targetBytes),
			),
		),
		thresholdBytes: inVm(missing((pressure) => pressure.thresholdBytes)),
		expectedBytes: Math.max(
			...disks.map(({ pressure }) => pressure.expectedBytes),
		),
	};
};

export interface LastCleanup {
	at: number;
	trigger: CleanupTrigger;
	reached: boolean;
	freedBytes: number;
	/** The step that removes every cache waited for running jobs. */
	skippedForJobs: boolean;
}

/**
 * Whether a new cleanup may start: soon after one that reached its target (the
 * jobs keep writing) or when the disk is now low where the last one only
 * anticipated, later after one that could not do better, much later after one
 * that found nothing to remove, and as soon as the machine is idle when the
 * last one skipped its idle step.
 */
export const cleanupDue = (
	last: LastCleanup | undefined,
	now: number,
	busyRunners: number,
	trigger: CleanupTrigger,
) => {
	if (!last) return true;
	const elapsed = now - last.at;
	if (last.skippedForJobs && busyRunners === 0) {
		return elapsed >= RETRY_WHEN_IDLE_MS;
	}
	const escalated = trigger === "low-disk" && last.trigger === "filling";
	if (last.reached || escalated) return elapsed >= RETRY_AFTER_REACHED_MS;
	return (
		elapsed >=
		(last.freedBytes < 1024 ** 2 ? RETRY_AFTER_EMPTY_MS : RETRY_AFTER_MISSED_MS)
	);
};

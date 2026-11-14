/**
 * x86_64 runners on a Mac. Apple silicon runs no x86_64 VM at a usable speed
 * (QEMU emulates every instruction), but Virtualization.framework shares
 * Rosetta with a Linux VM: the VM stays arm64 and runs x86_64 programs through
 * Rosetta, as macOS does. Some slots of the VM then run the linux-x64 build of
 * actions/runner, with the amd64 libraries it needs, so their jobs get an X64
 * runner: x86_64 tools, actions and Docker images (linux/amd64 by default).
 *
 * The x86_64 runners carry the pool labels with a suffix: a job asking only for
 * the pool labels never lands on them (Rosetta runs JIT-heavy code, Node.js
 * or .NET, two to three times slower than the native slots), and a job that
 * needs x86_64 asks for `<label>-x64`.
 */

/** Slots runnerctl accepts: 1 to 32. */
export const SLOT_MAX = 32;
/** x86_64 runners a machine may run at once. */
export const X64_MAX_RUNNERS = 4;
export const X64_LABEL_SUFFIX = "-x64";
/** Environment of the x86_64 slots: Docker builds and runs linux/amd64, as on an X64 runner. */
export const X64_DOCKER_PLATFORM = "linux/amd64";

/**
 * Slots of the x86_64 runners: the last ones (32, 31...), so they keep their
 * numbers when the budget, and with it the number of native slots, changes.
 */
export const x64Slots = (count: number) =>
	Array.from(
		{ length: Math.max(0, Math.min(count, X64_MAX_RUNNERS)) },
		(_, index) => SLOT_MAX - index,
	);

export const isX64Slot = (slot: number, count: number) =>
	x64Slots(count).includes(slot);

/** Native slots never reach the x86_64 ones. */
export const nativeMaxRunners = (resolved: number, x64Runners: number) =>
	Math.min(resolved, SLOT_MAX - x64Slots(x64Runners).length);

/** The labels of the pool (and of the machine) an x86_64 runner carries instead. */
export const x64Label = (label: string) => `${label}${X64_LABEL_SUFFIX}`;

/** Labels of the x86_64 runners of a machine. */
export const x64RunnerLabels = (input: {
	poolLabels: string[];
	extraLabels: string[];
	machineLabel: string;
}) => {
	const labels = [
		"self-hosted",
		"Linux",
		"X64",
		...input.poolLabels.map(x64Label),
		...input.extraLabels.map(x64Label),
		x64Label(input.machineLabel),
	];
	const seen = new Set<string>();
	return labels.filter((label) => {
		const key = label.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

/** What the VM reports of its x86_64 support (runtime v13 and later). */
export interface X64Status {
	/** Rosetta is registered for x86_64 programs in the VM. */
	rosetta: boolean;
	/** actions/runner release of the x86_64 slots; null before it is installed. */
	release: string | null;
}

/**
 * Why the x86_64 slots of a machine take no job yet; null once they can.
 * `hostRosetta` is what the Mac reports (null when unknown).
 */
export const x64Blocker = (input: {
	x64Runners: number;
	platform: "linux" | "macos";
	runtimeVersion: number;
	minRuntime: number;
	vmRosetta: boolean;
	hostRosetta: boolean | null;
	/** The Mac's architecture: an Intel Mac runs x86_64 natively. */
	hostArch?: string | null;
	status: X64Status | null;
	/** Why the last installation of the x86_64 runner failed, if it did. */
	installError?: string | null;
}): string | null => {
	if (input.x64Runners <= 0) return null;
	if (input.platform !== "macos") {
		return "x86_64 runners run on Macs only";
	}
	if (input.hostArch === "x86_64") {
		return "this Mac is an Intel Mac: its native runners are x86_64 already";
	}
	if (input.hostRosetta !== true) {
		return "Rosetta is not installed on the Mac: run the setup script of the machine again, it installs it";
	}
	if (!input.vmRosetta) {
		return "the VM restarts with Rosetta once no job runs";
	}
	if (input.runtimeVersion < input.minRuntime || !input.status) {
		return "waiting for the runtime update";
	}
	if (!input.status.rosetta) {
		return "Rosetta is not available in the VM";
	}
	// A release behind the native one still runs jobs while the new one installs.
	if (!input.status.release) {
		return input.installError
			? `the x86_64 runner could not be installed (${input.installError}); Dokploy tries again every 10 minutes`
			: "installing the x86_64 runner";
	}
	return null;
};

/** The x86_64 release the VM should have: the native one, once it is known. */
export const x64ReleaseDue = (
	status: X64Status | null,
	nativeRelease: string | null,
) =>
	Boolean(status?.rosetta && nativeRelease && status.release !== nativeRelease);

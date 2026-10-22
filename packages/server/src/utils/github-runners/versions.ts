/**
 * Whether the actions/runner release a machine runs is still accepted by
 * GitHub. Dokploy installs the pool's release on its own, but a pinned
 * version, a disabled machine or a failing update leave a machine behind, and
 * GitHub stops queuing jobs on a runner not updated within 30 days of a new
 * release:
 * https://docs.github.com/en/actions/reference/runners/self-hosted-runners
 */

/** "If you do not perform a software update within 30 days, the GitHub Actions service will not queue jobs to your runner." */
export const RUNNER_UPDATE_DEADLINE_MS = 30 * 24 * 60 * 60_000;
/**
 * Dokploy should have installed a release this long after it came out: its
 * release cache lasts 6 hours, and an update waits for the machine to be idle.
 */
export const RUNNER_UPDATE_GRACE_MS = 24 * 60 * 60_000;

export interface RunnerReleaseInfo {
	version: string;
	publishedAt: string;
}

/** Numeric comparison of dotted versions: 2.330.0 > 2.329.10 > 2.329.9. */
export const compareVersions = (a: string, b: string) => {
	const left = a.replace(/^v/, "").split(".");
	const right = b.replace(/^v/, "").split(".");
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference =
			(Number.parseInt(left[index] ?? "0", 10) || 0) -
			(Number.parseInt(right[index] ?? "0", 10) || 0);
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
};

/**
 * - current: the latest release;
 * - pending: older, and Dokploy installs the latest by itself (now, or once
 *   the machine is enabled again);
 * - outdated: older, and nothing will update it (pinned version, update not
 *   applied a day after the release);
 * - unsupported: a newer release came out more than 30 days ago, GitHub no
 *   longer queues jobs on it;
 * - unknown: no version reported yet, or the releases are not known yet.
 */
export type RunnerVersionState =
	| "current"
	| "pending"
	| "outdated"
	| "unsupported"
	| "unknown";

export interface RunnerVersionStatus {
	state: RunnerVersionState;
	installed: string | null;
	latest: string | null;
	/** When GitHub stops queuing jobs on the installed release, if older. */
	deadline: string | null;
	message: string;
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The newest of the known releases. */
export const latestRunnerRelease = (releases: RunnerReleaseInfo[]) =>
	releases.reduce<RunnerReleaseInfo | null>(
		(best, release) =>
			!best || compareVersions(release.version, best.version) > 0
				? release
				: best,
		null,
	);

export const runnerVersionStatus = (input: {
	/** Release the machine runs, as it reports it. */
	installed: string | null;
	releases: RunnerReleaseInfo[];
	/** Release the pool pins, if any. */
	pinned: string | null;
	/** Whether Dokploy installs updates on the machine now (enabled, ready). */
	updating: boolean;
	now: number;
}): RunnerVersionStatus => {
	const { installed, releases, pinned, updating, now } = input;
	const latestRelease = latestRunnerRelease(releases);
	const latest = latestRelease?.version ?? null;
	if (!installed || !latestRelease) {
		return {
			state: "unknown",
			installed,
			latest,
			deadline: null,
			message: installed
				? "The latest actions/runner release is not known yet"
				: "The machine has not reported its runner release yet",
		};
	}
	const newer = releases.filter(
		(release) => compareVersions(release.version, installed) > 0,
	);
	if (!newer.length) {
		return {
			state: "current",
			installed,
			latest,
			deadline: null,
			message: `actions/runner ${installed}, the latest release`,
		};
	}
	// GitHub counts the 30 days from the first release after the installed one.
	const firstNewer = Math.min(
		...newer.map((release) => Date.parse(release.publishedAt)),
	);
	const deadline = firstNewer + RUNNER_UPDATE_DEADLINE_MS;
	const pinnedBehind =
		pinned !== null && compareVersions(pinned, latestRelease.version) < 0;
	const fix = pinnedBehind
		? `Change the runner version pinned in the pool settings (${pinned}) to ${latest}, or clear it to follow the latest release.`
		: !updating
			? `Dokploy installs ${latest} once the machine is enabled and ready.`
			: `Dokploy installs ${latest} by itself: if it does not, see the machine's events and its last error.`;
	const base = {
		installed,
		latest,
		deadline: new Date(deadline).toISOString(),
	};
	if (now >= deadline) {
		return {
			...base,
			state: "unsupported",
			message: `actions/runner ${installed} was not updated within 30 days of a newer release: GitHub no longer queues jobs on it since ${day(deadline)}. ${fix}`,
		};
	}
	// Behind for more than a day: Dokploy should have caught up by now.
	const stuck =
		pinnedBehind || (updating && now - firstNewer > RUNNER_UPDATE_GRACE_MS);
	return {
		...base,
		state: stuck ? "outdated" : "pending",
		message: stuck
			? `actions/runner ${installed} is behind ${latest}: GitHub stops queuing jobs on it on ${day(deadline)}. ${fix}`
			: `actions/runner ${latest} is available. ${fix}`,
	};
};

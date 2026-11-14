/**
 * Machine health: a machine whose runners stay online can still lose the jobs
 * it runs (on 2026-11-14 the M4's VM ran out of memory four times in one
 * afternoon, and every running job died while its runners stayed online). Such
 * a machine is set aside for a while: it takes no new job, the ones it runs go
 * on, and the routing leaves the pool once no machine is left to take jobs.
 */
import type {
	GithubRunnerFailover,
	GithubRunnerNodeHealth,
} from "../../db/schema/github-runner";

/**
 * Jobs a controller marks interrupted right after it takes the lead may have
 * ended while no controller watched (their job file went with the slot armed
 * meanwhile): they do not count as lost.
 */
export const LEADERSHIP_GRACE_MS = 3 * 60_000;

/**
 * The machine a job ran on lost it: interrupted (crash, stop, a runner killed),
 * or ended while the kernel killed processes for memory (see oomRerun). A job
 * the re-run decision found successful lost nothing.
 */
export const lostJob = (
	job: {
		outcome: string;
		rerunStatus: string | null;
		rerunNote: string | null;
		finishedAt: string | null;
	},
	leaderSince: number | null,
) => {
	if (
		job.rerunStatus === "skipped" &&
		/^the job (did not fail|succeeded)/.test(job.rerunNote ?? "")
	) {
		return false;
	}
	if (job.outcome === "interrupted") {
		const at = Date.parse(job.finishedAt ?? "");
		return !(
			leaderSince !== null &&
			Number.isFinite(at) &&
			at >= leaderSince &&
			at < leaderSince + LEADERSHIP_GRACE_MS
		);
	}
	return job.outcome === "completed" && job.rerunStatus !== null;
};

export const DEFAULT_FAILOVER: GithubRunnerFailover = {
	interruptions: 2,
	windowMinutes: 10,
	cooldownMinutes: 30,
	mode: "auto",
};

const minutes = (value: number) => value * 60_000;

/**
 * Whether a machine stays set aside, given the jobs it lost within the window.
 * Each tick with enough losses pushes the end of the cooldown; the machine
 * comes back once the cooldown ends without new losses.
 */
export const decideMachineHealth = ({
	previous,
	lost,
	failover,
	now,
}: {
	previous: GithubRunnerNodeHealth | null;
	/** Jobs the machine lost within failover.windowMinutes. */
	lost: number;
	failover: GithubRunnerFailover;
	now: number;
}): GithubRunnerNodeHealth | null => {
	// Turned off, or the pool is kept as the target whatever happens.
	if (failover.interruptions === 0 || failover.mode === "pool") return null;
	const ongoing =
		previous !== null && Date.parse(previous.degradedUntil) > now
			? previous
			: null;
	if (failover.interruptions > 0 && lost >= failover.interruptions) {
		return {
			degradedSince: ongoing?.degradedSince ?? new Date(now).toISOString(),
			degradedUntil: new Date(
				now + minutes(failover.cooldownMinutes),
			).toISOString(),
			reason: `${lost} job${lost === 1 ? "" : "s"} lost within ${failover.windowMinutes} minutes`,
		};
	}
	return ongoing;
};

import type { WorkflowRun, WorkflowRunJob } from "./github-api";

/** Attempts of a run after which an interrupted job is no longer re-run. */
export const MAX_RUN_ATTEMPTS = 3;

const ACTIVE = new Set([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);

/**
 * A cancel the run did not follow within this delay is forced. The dead
 * runner never acknowledges a cancel; forcing at once would skip the run's
 * always() jobs (GitHub: use force-cancel when a run does not respond).
 */
export const FORCE_CANCEL_AFTER_MS = 3 * 60_000;

export type RerunDecision =
	| { action: "wait" }
	/** Only the interrupted job is left in the run: cancel it instead of waiting for GitHub's timeout. */
	| { action: "cancel"; note: string }
	/** The cancel was not followed: the run waits for a runner that is gone. */
	| { action: "force-cancel"; note: string }
	| { action: "rerun"; note: string }
	| { action: "skip"; note: string };

/** Whether an interrupted job is re-run at all, decided when it is interrupted. */
export const initialRerunStatus = (enabled: boolean, runAttempt: string) => {
	if (!enabled) return null;
	return Number(runAttempt) >= MAX_RUN_ATTEMPTS ? "skipped" : "pending";
};

/**
 * A job that ended while the kernel killed processes of its machine for memory
 * may have lost one of its own (a build or test process, with exit code 137):
 * it is queued like an interrupted job, and decideRerun re-runs it only if it
 * failed.
 */
export const oomRerun = (
	job: { oomKills?: number | null; runAttempt: string },
	enabled: boolean,
): { rerunStatus?: "pending" | "skipped"; rerunNote?: string } => {
	if (!job.oomKills) return {};
	const rerunStatus = initialRerunStatus(enabled, job.runAttempt);
	if (!rerunStatus) return {};
	const killed = `${job.oomKills} process${job.oomKills === 1 ? "" : "es"}`;
	return {
		rerunStatus,
		rerunNote:
			rerunStatus === "skipped"
				? `not re-run: already attempt ${job.runAttempt}`
				: `the machine ran out of memory during the job (${killed} killed)`,
	};
};

/**
 * Next step to recover a job a machine interrupted (crash, forced stop). GitHub
 * never moves a started job to another runner: the run has to complete, then
 * its failed jobs are re-run and land on any healthy machine of the pool.
 *
 * A machine that crashed leaves its job "in progress" until GitHub gives up on
 * the runner (about ten minutes); when nothing else runs in that run, it is
 * cancelled right away instead.
 */
export const decideRerun = (
	job: {
		runnerName: string;
		runAttempt: string;
		rerunStatus: string | null;
		/** When the run was cancelled, for a cancel the run does not follow. */
		rerunAt?: string | null;
		/** "completed" for a job that ended on its own (see oomRerun). */
		outcome?: string | null;
	},
	run: WorkflowRun,
	jobs: WorkflowRunJob[],
	now = Date.now(),
): RerunDecision => {
	if (run.runAttempt > Number(job.runAttempt)) {
		return {
			action: "skip",
			note: `already re-run (attempt ${run.runAttempt})`,
		};
	}
	// The job data comes from the machine: act only on a run this runner really ran.
	const ours = jobs.find((item) => item.runnerName === job.runnerName);
	if (!ours) {
		return { action: "skip", note: "this runner ran no job of that run" };
	}
	// Ended on its own while its machine ran out of memory: its runner reported
	// it, so the run never waits for it, and only a failure is worth a re-run.
	if (job.outcome === "completed") {
		if (ours.status === "completed" && ours.conclusion !== "failure") {
			return {
				action: "skip",
				note: `the job did not fail (${ours.conclusion ?? "no conclusion"})`,
			};
		}
		if (run.status !== "completed") return { action: "wait" };
	}
	if (run.status === "completed") {
		if (run.conclusion === "success") {
			return { action: "skip", note: "the run succeeded" };
		}
		return {
			action: "rerun",
			note: `re-running the failed jobs (attempt ${run.runAttempt + 1})`,
		};
	}
	if (job.rerunStatus === "cancelling") {
		const cancelledAt = Date.parse(job.rerunAt ?? "");
		return Number.isFinite(cancelledAt) &&
			now - cancelledAt > FORCE_CANCEL_AFTER_MS
			? {
					action: "force-cancel",
					note: "the run did not follow the cancel: forcing it",
				}
			: { action: "wait" };
	}
	if (ours.status === "completed") return { action: "wait" };
	const othersActive = jobs.some(
		(item) => item !== ours && ACTIVE.has(item.status),
	);
	if (othersActive) return { action: "wait" };
	return {
		action: "cancel",
		note: "the interrupted job was the last one running: cancelling the run",
	};
};

const PRECEDENCE: RerunDecision["action"][] = [
	"force-cancel",
	"cancel",
	"rerun",
	"wait",
	"skip",
];

/**
 * The step for the jobs of one run the pool queued: an interrupted job may need
 * the run cancelled while a job that ended on its own waits, and one job worth
 * a re-run is enough to re-run the failed jobs of the run.
 */
export const pickRerunDecision = (
	decisions: RerunDecision[],
): RerunDecision => {
	const [best] = [...decisions].sort(
		(a, b) => PRECEDENCE.indexOf(a.action) - PRECEDENCE.indexOf(b.action),
	);
	return best ?? { action: "wait" };
};

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

export type RerunDecision =
	| { action: "wait" }
	/** Only the interrupted job is left in the run: cancel it instead of waiting for GitHub's timeout. */
	| { action: "cancel"; note: string }
	| { action: "rerun"; note: string }
	| { action: "skip"; note: string };

/** Whether an interrupted job is re-run at all, decided when it is interrupted. */
export const initialRerunStatus = (enabled: boolean, runAttempt: string) => {
	if (!enabled) return null;
	return Number(runAttempt) >= MAX_RUN_ATTEMPTS ? "skipped" : "pending";
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
	job: { runnerName: string; runAttempt: string; rerunStatus: string | null },
	run: WorkflowRun,
	jobs: WorkflowRunJob[],
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
	if (run.status === "completed") {
		if (run.conclusion === "success") {
			return { action: "skip", note: "the run succeeded" };
		}
		return {
			action: "rerun",
			note: `re-running the failed jobs (attempt ${run.runAttempt + 1})`,
		};
	}
	if (job.rerunStatus === "cancelling" || ours.status === "completed") {
		return { action: "wait" };
	}
	const othersActive = jobs.some(
		(item) => item !== ours && ACTIVE.has(item.status),
	);
	if (othersActive) return { action: "wait" };
	return {
		action: "cancel",
		note: "the interrupted job was the last one running: cancelling the run",
	};
};

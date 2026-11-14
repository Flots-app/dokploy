/**
 * Duration KPIs of a pool: its jobs, and the pipelines (workflow runs) they
 * belong to. Only GitHub knows how long a whole pipeline took, jobs on other
 * runners included: the controller records each run attempt the pool took part
 * in once GitHub reports it completed (see scanPipelines in controller.ts).
 */
import type { WorkflowRunAttempt } from "./github-api";

/** The KPIs cover this window, like the job counts of the pool. */
export const KPI_WINDOW_MS = 24 * 60 * 60_000;
/** Workflows listed in the breakdown, the busiest first. */
export const MAX_WORKFLOWS = 10;

export interface DurationStats {
	count: number;
	averageSeconds: number | null;
	p90Seconds: number | null;
}

/** Average and 90th percentile (nearest rank) of durations, in seconds. */
export const durationStats = (values: number[]): DurationStats => {
	const sorted = values
		.filter((value) => Number.isFinite(value) && value >= 0)
		.sort((a, b) => a - b);
	if (!sorted.length) {
		return { count: 0, averageSeconds: null, p90Seconds: null };
	}
	return {
		count: sorted.length,
		averageSeconds: Math.round(
			sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		),
		p90Seconds: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null,
	};
};

/**
 * How long a run attempt took, from its start to its last update, once GitHub
 * reports it completed; null before (or without the times).
 */
export const pipelineDuration = (attempt: WorkflowRunAttempt) => {
	if (attempt.status !== "completed") return null;
	const startedAt = attempt.startedAt
		? Date.parse(attempt.startedAt)
		: Number.NaN;
	const completedAt = attempt.updatedAt
		? Date.parse(attempt.updatedAt)
		: Number.NaN;
	if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
	return {
		startedAt: new Date(startedAt).toISOString(),
		completedAt: new Date(completedAt).toISOString(),
		durationSeconds: Math.max(0, Math.round((completedAt - startedAt) / 1000)),
	};
};

export interface PipelineRow {
	repository: string;
	workflow: string;
	conclusion: string | null;
	durationSeconds: number;
}

/**
 * Pipeline KPIs: the durations count successful runs only (a failed run stops
 * early, a cancelled one at any point); the run counts include every outcome.
 */
export const pipelineStats = (rows: PipelineRow[]) => {
	const succeeded = (list: PipelineRow[]) =>
		list.filter((row) => row.conclusion === "success");
	const groups = new Map<string, PipelineRow[]>();
	for (const row of rows) {
		const key = `${row.repository}\u0000${row.workflow}`;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const workflows = [...groups.values()]
		.map((list) => ({
			repository: list[0]?.repository ?? "",
			workflow: list[0]?.workflow ?? "",
			runs: list.length,
			succeeded: succeeded(list).length,
			...durationStats(succeeded(list).map((row) => row.durationSeconds)),
		}))
		.sort(
			(a, b) =>
				b.runs - a.runs ||
				a.repository.localeCompare(b.repository) ||
				a.workflow.localeCompare(b.workflow),
		)
		.slice(0, MAX_WORKFLOWS);
	return {
		runs: rows.length,
		succeeded: succeeded(rows).length,
		...durationStats(succeeded(rows).map((row) => row.durationSeconds)),
		workflows,
	};
};

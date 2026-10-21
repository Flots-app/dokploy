import type { RouterOutputs } from "@/utils/api";

export type RunnerPool = RouterOutputs["githubRunner"]["overview"][number];
export type RunnerMachine = RunnerPool["nodes"][number];
export type RunnerSlot = NonNullable<
	RunnerMachine["observed"]
>["slots"][number];

const GiB = 1024 ** 3;

export const formatBytes = (bytes: number | null | undefined) => {
	if (bytes === null || bytes === undefined) return "—";
	if (bytes >= 1000 * GiB) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
	if (bytes >= GiB) return `${Math.round((bytes / GiB) * 10) / 10} GiB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`;
	return `${Math.round(bytes / 1024)} KiB`;
};

export const formatDuration = (seconds: number | null | undefined) => {
	if (seconds === null || seconds === undefined) return "—";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/** Seconds elapsed between an ISO date and `now` (from useNow). */
export const elapsed = (iso: string | null | undefined, now: number) => {
	if (!iso) return null;
	return Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
};

export const runUrl = (job: { repository: string; runId: string }) =>
	`https://github.com/${job.repository}/actions/runs/${job.runId}`;

export const formatCpus = (cpus: number) =>
	`${cpus} CPU${cpus === 1 ? "" : "s"}`;

export const percentText = (value: number | null | undefined) =>
	value === null || value === undefined ? "—" : `${Math.round(value)}%`;

/** A typed whole number within bounds, or null while it is not one yet. */
export const boundedNumber = (text: string, min: number, max?: number) => {
	if (!/^\d+$/.test(text.trim())) return null;
	const value = Number(text);
	return value >= min && (max === undefined || value <= max) ? value : null;
};

/** What a number field settles on when left: the typed value, clamped. */
export const settleNumber = (
	text: string,
	min: number,
	max: number | undefined,
	fallback: number,
) => {
	if (!/^\d+$/.test(text.trim())) return fallback;
	const value = Math.max(min, Number(text));
	return max === undefined ? value : Math.min(max, value);
};

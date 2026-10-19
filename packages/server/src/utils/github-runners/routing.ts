/**
 * Routing with a fallback. GitHub never falls back from one runs-on to another:
 * a job waits up to a day for a runner carrying all its labels. So Dokploy
 * publishes the decision in an Actions variable, which workflows read with
 * `runs-on: ${{ fromJSON(vars.NAME || '"ubuntu-24.04"') }}`. GitHub evaluates
 * it when it queues each job, and again when a job is re-run.
 */
import type { GithubRunnerRouting } from "@dokploy/server/db/schema";

/** An ephemeral runner being replaced, or a short hiccup, must not move the jobs. */
export const ROUTING_GRACE_MS = 2 * 60_000;
/** The variable is written again now and then, in case someone edited it. */
export const ROUTING_RESYNC_MS = 15 * 60_000;
export const ROUTING_RETRY_MS = 30_000;
/** A job queued for less than this may still be picked by a runner coming up. */
export const REROUTE_MIN_QUEUED_MS = 60_000;

export const poolRunsOn = (labels: string[]) =>
	JSON.stringify(["self-hosted", ...labels]);

export const fallbackRunsOn = (labels: string[]) =>
	JSON.stringify(labels.length === 1 ? labels[0] : labels);

/** The runs-on line workflows use; the default covers a missing variable. */
export const runsOnExpression = (variable: string, fallbackLabels: string[]) =>
	`\${{ fromJSON(vars.${variable} || '${fallbackRunsOn(fallbackLabels)}') }}`;

export interface RoutingInput {
	previous: GithubRunnerRouting | null;
	/** At least one runner of the pool is ON: online, on a machine taking jobs. */
	available: boolean;
	/** At least one machine is enabled; when none is, nothing is coming back. */
	anyEnabled: boolean;
	labels: string[];
	fallbackLabels: string[];
	now: number;
}

/**
 * The pool while at least one of its runners is ON, the fallback otherwise.
 * Going back to the pool is immediate; leaving it waits for a short grace,
 * unless no machine is enabled any more.
 */
export const decideRouting = ({
	previous,
	available,
	anyEnabled,
	labels,
	fallbackLabels,
	now,
}: RoutingInput): GithubRunnerRouting => {
	const at = new Date(now).toISOString();
	const unavailableSince = available
		? null
		: (previous?.unavailableSince ?? at);
	const graceful =
		!available &&
		anyEnabled &&
		previous?.target === "pool" &&
		now - Date.parse(unavailableSince ?? at) < ROUTING_GRACE_MS;
	const target: GithubRunnerRouting["target"] =
		available || graceful ? "pool" : "fallback";
	return {
		variable: previous?.variable ?? null,
		syncedValue: previous?.syncedValue ?? null,
		syncedAt: previous?.syncedAt ?? null,
		attemptedAt: previous?.attemptedAt ?? null,
		error: previous?.error ?? null,
		target,
		value:
			target === "pool" ? poolRunsOn(labels) : fallbackRunsOn(fallbackLabels),
		since: previous?.target === target ? previous.since : at,
		unavailableSince,
	};
};

/** Whether the variable must be written now: changed, or not checked for a while. */
export const routingSyncDue = (
	routing: GithubRunnerRouting,
	variable: string,
	now: number,
) => {
	const since = (iso: string | null) =>
		iso ? now - Date.parse(iso) : Number.POSITIVE_INFINITY;
	if (routing.variable !== variable || routing.value !== routing.syncedValue) {
		return !routing.error || since(routing.attemptedAt) >= ROUTING_RETRY_MS;
	}
	return since(routing.syncedAt) >= ROUTING_RESYNC_MS;
};

/**
 * A queued job waits for the pool when it asks for all the pool labels. A pool
 * without labels routes nothing: every self-hosted job would match.
 */
export const waitsForPool = (jobLabels: string[], poolLabels: string[]) => {
	if (!poolLabels.length) return false;
	const asked = new Set(jobLabels.map((label) => label.toLowerCase()));
	return ["self-hosted", ...poolLabels].every((label) =>
		asked.has(label.toLowerCase()),
	);
};

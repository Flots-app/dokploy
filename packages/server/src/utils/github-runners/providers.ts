/**
 * The fallback chain of a pool: providers its jobs go to, in order, while its
 * machines cannot take them, each within a monthly budget. A provider over its
 * budget is skipped; with none left, the jobs stay on the pool and wait.
 */
import type {
	GithubRunnerFallbackProvider,
	GithubRunnerProviderBudget,
	GithubRunnerProviderUsage,
} from "../../db/schema/github-runner";

/** Usage older than this no longer decides: the provider may be far past it. */
export const USAGE_STALE_MS = 2 * 60 * 60_000;
/** How often the controller reads the usage of each provider. */
export const USAGE_REFRESH_MS = 15 * 60_000;

export const PROVIDER_NAMES: Record<
	GithubRunnerFallbackProvider["kind"],
	string
> = {
	blacksmith: "Blacksmith",
	github: "GitHub-hosted",
};

/** "2026-11": the month a provider bills, in UTC. */
export const usageMonth = (now: number) =>
	new Date(now).toISOString().slice(0, 7);

/** Minutes a budget allows in a month: the free ones, then what the overspend buys. */
export const limitMinutes = (budget: GithubRunnerProviderBudget) => {
	if (budget.overspend === 0) return budget.freeMinutes;
	if (budget.pricePerMinute === 0) return Number.POSITIVE_INFINITY;
	return budget.freeMinutes + budget.overspend / budget.pricePerMinute;
};

export type ProviderStatus = "within" | "warning" | "exhausted" | "unknown";

export interface ProviderState {
	status: ProviderStatus;
	/** Why it is not within, for the routing line and the alerts. */
	reason: string | null;
	minutes: number | null;
	/** Spend past the free minutes this month: reported, or priced from the minutes. */
	spend: number | null;
	limitMinutes: number | null;
	/** Minutes at the end of the month at this month's pace. */
	projectedMinutes: number | null;
}

const daysInMonth = (now: Date) =>
	new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
	).getUTCDate();

const round = (value: number) => Math.round(value * 100) / 100;

/** Where a provider stands with its budget this month. */
export const providerState = (
	provider: GithubRunnerFallbackProvider,
	usage: GithubRunnerProviderUsage | undefined,
	now: number,
): ProviderState => {
	const empty = {
		minutes: null,
		spend: null,
		limitMinutes: null,
		projectedMinutes: null,
	};
	const { budget } = provider;
	if (!budget) return { status: "within", reason: null, ...empty };
	const limit = limitMinutes(budget);
	const unknown = (reason: string): ProviderState => ({
		status: "unknown",
		reason,
		...empty,
		limitMinutes: Number.isFinite(limit) ? limit : null,
	});
	// Without fresh figures, a budget cannot be kept: the provider is skipped.
	if (!usage || usage.month !== usageMonth(now)) {
		return unknown("usage not read yet this month");
	}
	if (usage.error || usage.minutes === null) {
		return unknown(`usage unreadable: ${usage.error ?? "no figure"}`);
	}
	if (
		!usage.measuredAt ||
		now - Date.parse(usage.measuredAt) > USAGE_STALE_MS
	) {
		return unknown("usage not read for over two hours");
	}
	const minutes = usage.minutes;
	const spend =
		usage.spend ??
		Math.max(0, minutes - budget.freeMinutes) * budget.pricePerMinute;
	const date = new Date(now);
	const elapsedDays =
		date.getUTCDate() -
		1 +
		(date.getUTCHours() * 60 + date.getUTCMinutes()) / 1440;
	const projectedMinutes =
		elapsedDays > 0 ? (minutes / elapsedDays) * daysInMonth(date) : minutes;
	const figures = {
		minutes,
		spend: round(spend),
		limitMinutes: Number.isFinite(limit) ? limit : null,
		projectedMinutes: Math.round(projectedMinutes),
	};
	const exhausted =
		budget.overspend === 0
			? minutes >= budget.freeMinutes
			: spend >= budget.overspend;
	if (exhausted) {
		return {
			status: "exhausted",
			reason:
				budget.overspend === 0
					? `${Math.round(minutes)} of its ${budget.freeMinutes} free minutes used`
					: `${round(spend)} spent past its free minutes, of ${budget.overspend} allowed`,
			...figures,
		};
	}
	const share = Number.isFinite(limit) && limit > 0 ? minutes / limit : 0;
	if (share * 100 >= budget.warningPercent) {
		return {
			status: "warning",
			reason: `${Math.round(share * 100)}% of its budget used`,
			...figures,
		};
	}
	return { status: "within", reason: null, ...figures };
};

export interface FallbackChoice {
	/** The provider the jobs go to; null for the pool's plain fallback labels. */
	provider: GithubRunnerFallbackProvider | null;
	labels: string[];
	x64Labels: string[];
	/** Every provider of a chain is over budget or unreadable: the jobs stay on the pool. */
	exhausted: boolean;
	/** Why each skipped provider was skipped. */
	skipped: { kind: GithubRunnerFallbackProvider["kind"]; reason: string }[];
}

/**
 * The first provider of the chain within its budget. A pool without a chain
 * keeps its fallback labels, which no budget limits.
 */
export const chooseFallback = (input: {
	chain: GithubRunnerFallbackProvider[];
	usage: Record<string, GithubRunnerProviderUsage>;
	fallbackLabels: string[];
	x64FallbackLabels: string[];
	now: number;
}): FallbackChoice => {
	if (!input.chain.length) {
		return {
			provider: null,
			labels: input.fallbackLabels,
			x64Labels: input.x64FallbackLabels,
			exhausted: false,
			skipped: [],
		};
	}
	const skipped: FallbackChoice["skipped"] = [];
	for (const provider of input.chain) {
		const state = providerState(provider, input.usage[provider.id], input.now);
		if (state.status === "within" || state.status === "warning") {
			return {
				provider,
				labels: provider.labels,
				x64Labels: provider.x64Labels,
				exhausted: false,
				skipped,
			};
		}
		skipped.push({ kind: provider.kind, reason: state.reason ?? state.status });
	}
	return {
		provider: null,
		labels: input.fallbackLabels,
		x64Labels: input.x64FallbackLabels,
		exhausted: true,
		skipped,
	};
};

/**
 * Where the jobs of a class go when they leave the pool: the labels the chosen
 * provider names for the class, else its labels for the class's architecture;
 * without a provider, the class's own fallback.
 */
export const classFallbackLabels = (
	choice: FallbackChoice,
	jobClass: { id: string; arch: "native" | "x64"; fallbackLabels: string[] },
) => {
	const { provider } = choice;
	if (!provider) return jobClass.fallbackLabels;
	return (
		provider.classLabels?.[jobClass.id] ??
		(jobClass.arch === "x64" ? provider.x64Labels : provider.labels)
	);
};

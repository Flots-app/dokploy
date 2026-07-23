export type ActiveAlertAgeFilter =
	| "all"
	| "under-1h"
	| "1h-24h"
	| "1d-7d"
	| "over-7d";

export type ActiveAlertSort = "newest" | "oldest" | "severity";

export type ActiveAlertFilters = {
	search: string;
	severity: "all" | "info" | "warning" | "critical";
	databaseType: "all" | "postgres" | "redis";
	projectId: string;
	environmentId: string;
	age: ActiveAlertAgeFilter;
	sort: ActiveAlertSort;
};

type FilterableActiveAlert = {
	name: string;
	description: string;
	databaseName: string;
	projectId: string | null;
	projectName: string;
	environmentId: string | null;
	environmentName: string;
	severity: "info" | "warning" | "critical";
	databaseType: "postgres" | "redis" | null;
	metricKey: string | null;
	startsAt: Date | string;
};

const severityRank = {
	critical: 0,
	warning: 1,
	info: 2,
} as const;

const matchesAge = (
	startsAt: Date | string,
	filter: ActiveAlertAgeFilter,
	now: Date,
) => {
	if (filter === "all") return true;
	const ageMs = Math.max(0, now.getTime() - new Date(startsAt).getTime());
	const hour = 3_600_000;
	const day = 24 * hour;

	switch (filter) {
		case "under-1h":
			return ageMs < hour;
		case "1h-24h":
			return ageMs >= hour && ageMs < day;
		case "1d-7d":
			return ageMs >= day && ageMs < 7 * day;
		case "over-7d":
			return ageMs >= 7 * day;
	}
};

export const filterActiveAlerts = <T extends FilterableActiveAlert>(
	alerts: readonly T[],
	filters: ActiveAlertFilters,
	now = new Date(),
) => {
	const search = filters.search.trim().toLowerCase();
	const filtered = alerts.filter((alert) => {
		if (filters.severity !== "all" && alert.severity !== filters.severity) {
			return false;
		}
		if (
			filters.databaseType !== "all" &&
			alert.databaseType !== filters.databaseType
		) {
			return false;
		}
		if (filters.projectId !== "all" && alert.projectId !== filters.projectId) {
			return false;
		}
		if (
			filters.environmentId !== "all" &&
			alert.environmentId !== filters.environmentId
		) {
			return false;
		}
		if (!matchesAge(alert.startsAt, filters.age, now)) {
			return false;
		}
		if (!search) return true;

		return [
			alert.name,
			alert.description,
			alert.databaseName,
			alert.projectName,
			alert.environmentName,
			alert.metricKey ?? "",
		].some((value) => value.toLowerCase().includes(search));
	});

	return filtered.sort((left, right) => {
		if (filters.sort === "severity") {
			const severityDifference =
				severityRank[left.severity] - severityRank[right.severity];
			if (severityDifference !== 0) return severityDifference;
		}
		const timeDifference =
			new Date(right.startsAt).getTime() - new Date(left.startsAt).getTime();
		return filters.sort === "oldest" ? -timeDifference : timeDifference;
	});
};

import { describe, expect, it } from "vitest";
import {
	type ActiveAlertFilters,
	filterActiveAlerts,
} from "@/components/dashboard/alerts/active-alert-filters";

const filters: ActiveAlertFilters = {
	search: "",
	severity: "all",
	databaseType: "all",
	projectId: "all",
	environmentId: "all",
	age: "all",
	sort: "newest",
};

const alerts = [
	{
		name: "Redis unavailable",
		description: "Redis has been down",
		databaseName: "Cache",
		projectId: "project-1",
		projectName: "Storefront",
		environmentId: "environment-1",
		environmentName: "production",
		severity: "critical" as const,
		databaseType: "redis" as const,
		metricKey: "redis.up",
		startsAt: "2026-07-23T11:30:00.000Z",
	},
	{
		name: "Connections high",
		description: "Connection utilization is elevated",
		databaseName: "Primary",
		projectId: "project-2",
		projectName: "Back office",
		environmentId: "environment-2",
		environmentName: "staging",
		severity: "warning" as const,
		databaseType: "postgres" as const,
		metricKey: "postgres.connections.utilization",
		startsAt: "2026-07-20T12:00:00.000Z",
	},
];

describe("filterActiveAlerts", () => {
	it("combines search, database, severity, project, and environment filters", () => {
		expect(
			filterActiveAlerts(
				alerts,
				{
					...filters,
					search: "store",
					severity: "critical",
					databaseType: "redis",
					projectId: "project-1",
					environmentId: "environment-1",
				},
				new Date("2026-07-23T12:00:00.000Z"),
			).map((alert) => alert.name),
		).toEqual(["Redis unavailable"]);
	});

	it("filters by active duration and sorts by severity", () => {
		expect(
			filterActiveAlerts(
				alerts,
				{ ...filters, age: "over-7d" },
				new Date("2026-07-27T12:00:00.000Z"),
			).map((alert) => alert.name),
		).toEqual(["Connections high"]);

		expect(
			filterActiveAlerts(
				alerts,
				{ ...filters, sort: "severity" },
				new Date("2026-07-23T12:00:00.000Z"),
			).map((alert) => alert.severity),
		).toEqual(["critical", "warning"]);
	});
});

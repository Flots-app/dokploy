import { DatabaseAlertRuleInput } from "@dokploy/server/db/schema";
import {
	compileAlertRule,
	compileMetricQuery,
	DATABASE_ALERT_PRESETS,
	DATABASE_METRICS,
	validateDatabaseAlertInput,
} from "@dokploy/server/observability/catalog";
import { assertPromQlServiceScope } from "@dokploy/server/observability/promql";
import { describe, expect, it } from "vitest";

describe("DatabaseAlertRuleInput", () => {
	const valid = {
		serviceId: "postgres-1",
		metricKey: "postgres.up",
		operator: "eq" as const,
		threshold: 0,
		lookbackWindow: "1m",
		forDuration: "1m",
		severity: "critical" as const,
		name: "alert-postgres-apps-frc-prd-cpu-critical-gt-90",
		description: "The database is unavailable",
		notificationIds: ["notification-1"],
		enabled: true,
	};

	it("exposes exactly the documented public fields", () => {
		const parsed = DatabaseAlertRuleInput.parse(valid);
		expect(Object.keys(parsed).sort()).toEqual(Object.keys(valid).sort());
	});

	it.each(["", "01m", "-1m", "1 minute", "1ms", "1M"])(
		"rejects invalid duration %s",
		(duration) => {
			expect(() =>
				DatabaseAlertRuleInput.parse({
					...valid,
					lookbackWindow: duration,
				}),
			).toThrow();
		},
	);

	it("rejects non-finite thresholds and arbitrary operators", () => {
		expect(() =>
			DatabaseAlertRuleInput.parse({ ...valid, threshold: Number.NaN }),
		).toThrow();
		expect(() =>
			DatabaseAlertRuleInput.parse({ ...valid, operator: "contains" }),
		).toThrow();
	});

	it.each([
		"Postgres down",
		"alert_Postgres_down",
		"alert-postgres--down",
		"alert-postgres-down-",
		"postgres-down",
	])("rejects alert names outside the naming convention: %s", (name) => {
		expect(() => DatabaseAlertRuleInput.parse({ ...valid, name })).toThrow(
			"lowercase kebab-case",
		);
	});
});

describe("stable metric catalog", () => {
	it("covers every required PostgreSQL category", () => {
		const keys = DATABASE_METRICS.map((metric) => metric.key);
		expect(keys).toEqual(
			expect.arrayContaining([
				"postgres.up",
				"postgres.uptime",
				"postgres.connections.active",
				"postgres.connections.idle",
				"postgres.connections.max",
				"postgres.connections.utilization",
				"postgres.transactions.commits",
				"postgres.transactions.rollbacks",
				"postgres.transactions.rollback_ratio",
				"postgres.tuples.throughput",
				"postgres.cache_hit_ratio",
				"postgres.database_size",
				"postgres.temp_files",
				"postgres.deadlocks",
				"postgres.locks",
				"postgres.replication_lag",
			]),
		);
	});

	it("covers every required Redis category", () => {
		const keys = DATABASE_METRICS.map((metric) => metric.key);
		expect(keys).toEqual(
			expect.arrayContaining([
				"redis.up",
				"redis.uptime",
				"redis.role",
				"redis.version",
				"redis.clients.connected",
				"redis.clients.blocked",
				"redis.memory.used",
				"redis.memory.max",
				"redis.memory.fragmentation",
				"redis.operations",
				"redis.commands",
				"redis.cache_hit_ratio",
				"redis.keys",
				"redis.expirations",
				"redis.evictions",
				"redis.rejected_connections",
				"redis.network.input",
				"redis.network.output",
				"redis.persistence.last_save",
				"redis.replication.lag",
			]),
		);
	});

	it("compiles every catalog query with an exact service matcher", () => {
		for (const metric of DATABASE_METRICS) {
			const query = compileMetricQuery(metric, 'service-"safe', "5m");
			expect(() =>
				assertPromQlServiceScope(query, 'service-"safe'),
			).not.toThrow();
			expect(query).not.toContain("$serviceId");
			expect(query).not.toContain("$window");
		}
	});

	it("rejects lookback injection before compiling a current-value query", () => {
		const metric = DATABASE_METRICS.find(
			(candidate) => candidate.key === "postgres.up",
		);
		expect(metric).toBeDefined();
		expect(() =>
			compileMetricQuery(
				metric!,
				"postgres-1",
				'5m]) or redis_up{service_id="redis-2"}',
			),
		).toThrow("Invalid Prometheus duration");
	});

	it("contains no high-cardinality or sensitive collection features", () => {
		const serialized = JSON.stringify(DATABASE_METRICS).toLowerCase();
		expect(serialized).not.toContain("pg_stat_statements");
		expect(serialized).not.toContain("query_text");
		expect(serialized).not.toContain("key_scan");
	});
});

describe("alert compilation and presets", () => {
	it("guards availability alerts with expected-up", () => {
		const rule = compileAlertRule({
			databaseAlertRuleId: "rule-1",
			serviceId: "postgres-1",
			metricKey: "postgres.up",
			operator: "eq",
			threshold: 0,
			lookbackWindow: "1m",
			forDuration: "1m",
			severity: "critical",
			name: "alert-postgres-availability-critical-eq-0",
			description: "Unavailable",
		});
		expect(rule.expr).toContain(
			'dokploy_database_expected_up{service_id="postgres-1"} == 1',
		);
		expect(rule.expr).toContain("and on()");
		expect(rule.labels).toMatchObject({
			service_id: "postgres-1",
			rule_id: "rule-1",
		});
	});

	it("rejects a catalog-invalid operator", () => {
		expect(() =>
			validateDatabaseAlertInput(
				{
					serviceId: "postgres-1",
					metricKey: "postgres.cache_hit_ratio",
					operator: "eq",
					threshold: 90,
					lookbackWindow: "5m",
					forDuration: "5m",
					severity: "warning",
					name: "alert-postgres-cache-hit-warning-eq-90",
					description: "",
					notificationIds: [],
					enabled: true,
				},
				"postgres",
			),
		).toThrow("Operator");
	});

	it("ships disabled presets only", () => {
		expect(DATABASE_ALERT_PRESETS.postgres).toHaveLength(6);
		expect(DATABASE_ALERT_PRESETS.redis).toHaveLength(7);
		for (const preset of [
			...DATABASE_ALERT_PRESETS.postgres,
			...DATABASE_ALERT_PRESETS.redis,
		]) {
			expect(preset.enabled).toBe(false);
			expect(
				preset.name.startsWith(`alert-${preset.metricKey.split(".")[0]}-`),
			).toBe(true);
			expect(() =>
				DatabaseAlertRuleInput.parse({
					...preset,
					serviceId: "service-1",
					notificationIds: [],
				}),
			).not.toThrow();
		}
	});

	it("requires the alert name to match the database type", () => {
		expect(() =>
			validateDatabaseAlertInput(
				{
					serviceId: "postgres-1",
					metricKey: "postgres.up",
					operator: "eq",
					threshold: 0,
					lookbackWindow: "1m",
					forDuration: "1m",
					severity: "critical",
					name: "alert-redis-availability-critical-eq-0",
					description: "",
					notificationIds: [],
					enabled: true,
				},
				"postgres",
			),
		).toThrow('must start with "alert-postgres-"');
	});
});

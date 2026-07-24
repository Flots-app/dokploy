import type {
	DatabaseAlertRuleInputType,
	databaseAlertRules,
} from "../db/schema/observability";

export type DatabaseKind = "postgres" | "redis";
export type MetricUnit =
	| "boolean"
	| "seconds"
	| "count"
	| "percent"
	| "bytes"
	| "bytes_per_second"
	| "operations_per_second"
	| "tuples_per_second";

export type MetricDefinition = {
	key: string;
	databaseType: DatabaseKind;
	label: string;
	description: string;
	unit: MetricUnit;
	/**
	 * PromQL template. `$serviceId` and `$window` are replaced by the compiler.
	 * Every raw vector selector deliberately includes an exact service_id matcher.
	 */
	query: string;
	operators: DatabaseAlertRuleInputType["operator"][];
	defaultLookback: string;
};

const allComparisons: DatabaseAlertRuleInputType["operator"][] = [
	"gt",
	"gte",
	"lt",
	"lte",
	"eq",
	"neq",
];

const thresholdComparisons: DatabaseAlertRuleInputType["operator"][] = [
	"gt",
	"gte",
	"lt",
	"lte",
];

export const DATABASE_METRICS: MetricDefinition[] = [
	{
		key: "postgres.up",
		databaseType: "postgres",
		label: "Availability",
		description: "Whether the PostgreSQL exporter can reach the database.",
		unit: "boolean",
		query: 'min(last_over_time(pg_up{service_id="$serviceId"}[$window]))',
		operators: allComparisons,
		defaultLookback: "1m",
	},
	{
		key: "postgres.uptime",
		databaseType: "postgres",
		label: "Uptime",
		description: "Seconds since the PostgreSQL server started.",
		unit: "seconds",
		query:
			'time() - max(pg_postmaster_start_time_seconds{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.connections.active",
		databaseType: "postgres",
		label: "Active connections",
		description: "Connections currently executing work.",
		unit: "count",
		query:
			'sum(pg_stat_activity_count{service_id="$serviceId",state="active"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.connections.idle",
		databaseType: "postgres",
		label: "Idle connections",
		description: "Connections currently idle.",
		unit: "count",
		query: 'sum(pg_stat_activity_count{service_id="$serviceId",state="idle"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.connections.max",
		databaseType: "postgres",
		label: "Maximum connections",
		description: "Configured PostgreSQL connection limit.",
		unit: "count",
		query: 'max(pg_settings_max_connections{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.connections.utilization",
		databaseType: "postgres",
		label: "Connection utilization",
		description: "Active and idle connections divided by the configured limit.",
		unit: "percent",
		query:
			'100 * sum(pg_stat_activity_count{service_id="$serviceId"}) / clamp_min(max(pg_settings_max_connections{service_id="$serviceId"}), 1)',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.transactions.commits",
		databaseType: "postgres",
		label: "Commits",
		description: "Committed transactions per second.",
		unit: "operations_per_second",
		query:
			'sum(rate(pg_stat_database_xact_commit{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.transactions.rollbacks",
		databaseType: "postgres",
		label: "Rollbacks",
		description: "Rolled-back transactions per second.",
		unit: "operations_per_second",
		query:
			'sum(rate(pg_stat_database_xact_rollback{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.transactions.rollback_ratio",
		databaseType: "postgres",
		label: "Rollback ratio",
		description: "Percentage of transactions rolled back.",
		unit: "percent",
		query:
			'100 * sum(rate(pg_stat_database_xact_rollback{service_id="$serviceId"}[$window])) / clamp_min(sum(rate(pg_stat_database_xact_commit{service_id="$serviceId"}[$window])) + sum(rate(pg_stat_database_xact_rollback{service_id="$serviceId"}[$window])), 0.000001)',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.tuples.throughput",
		databaseType: "postgres",
		label: "Tuple throughput",
		description: "Rows returned, inserted, updated, or deleted per second.",
		unit: "tuples_per_second",
		query:
			'sum(rate(pg_stat_database_tup_returned{service_id="$serviceId"}[$window]) + rate(pg_stat_database_tup_inserted{service_id="$serviceId"}[$window]) + rate(pg_stat_database_tup_updated{service_id="$serviceId"}[$window]) + rate(pg_stat_database_tup_deleted{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.cache_hit_ratio",
		databaseType: "postgres",
		label: "Cache hit ratio",
		description: "Percentage of block reads served by PostgreSQL cache.",
		unit: "percent",
		query:
			'100 * sum(rate(pg_stat_database_blks_hit{service_id="$serviceId"}[$window])) / clamp_min(sum(rate(pg_stat_database_blks_hit{service_id="$serviceId"}[$window])) + sum(rate(pg_stat_database_blks_read{service_id="$serviceId"}[$window])), 0.000001)',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.database_size",
		databaseType: "postgres",
		label: "Database size",
		description: "Total database size in bytes.",
		unit: "bytes",
		query: 'sum(pg_database_size_bytes{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.temp_files",
		databaseType: "postgres",
		label: "Temporary files",
		description: "Temporary files created per second.",
		unit: "operations_per_second",
		query:
			'sum(rate(pg_stat_database_temp_files{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.temp_bytes",
		databaseType: "postgres",
		label: "Temporary file throughput",
		description: "Temporary-file bytes written per second.",
		unit: "bytes_per_second",
		query:
			'sum(rate(pg_stat_database_temp_bytes{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.deadlocks",
		databaseType: "postgres",
		label: "Deadlocks",
		description: "Deadlocks observed in the selected window.",
		unit: "count",
		query:
			'sum(increase(pg_stat_database_deadlocks{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.locks",
		databaseType: "postgres",
		label: "Locks",
		description: "Current number of PostgreSQL locks.",
		unit: "count",
		query: 'sum(pg_locks_count{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "postgres.replication_lag",
		databaseType: "postgres",
		label: "Replication lag",
		description: "Greatest observed replication lag in seconds.",
		unit: "seconds",
		query: 'max(pg_replication_lag{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.up",
		databaseType: "redis",
		label: "Availability",
		description: "Whether the Redis exporter can reach the database.",
		unit: "boolean",
		query: 'min(last_over_time(redis_up{service_id="$serviceId"}[$window]))',
		operators: allComparisons,
		defaultLookback: "1m",
	},
	{
		key: "redis.uptime",
		databaseType: "redis",
		label: "Uptime",
		description: "Seconds since Redis started.",
		unit: "seconds",
		query: 'max(redis_uptime_in_seconds{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.role",
		databaseType: "redis",
		label: "Primary role",
		description: "1 when Redis reports the master role, 0 otherwise.",
		unit: "boolean",
		query: 'max(redis_instance_info{service_id="$serviceId",role="master"})',
		operators: allComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.version",
		databaseType: "redis",
		label: "Version information",
		description:
			"Redis build information; the version is exposed as a series label.",
		unit: "boolean",
		query: 'max(redis_instance_info{service_id="$serviceId"})',
		operators: allComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.clients.connected",
		databaseType: "redis",
		label: "Connected clients",
		description: "Current number of connected Redis clients.",
		unit: "count",
		query: 'max(redis_connected_clients{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.clients.blocked",
		databaseType: "redis",
		label: "Blocked clients",
		description: "Clients waiting on blocking operations.",
		unit: "count",
		query: 'max(redis_blocked_clients{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.memory.used",
		databaseType: "redis",
		label: "Memory used",
		description: "Bytes of memory used by Redis.",
		unit: "bytes",
		query: 'max(redis_memory_used_bytes{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.memory.max",
		databaseType: "redis",
		label: "Maximum memory",
		description: "Configured Redis maxmemory value.",
		unit: "bytes",
		query: 'max(redis_memory_max_bytes{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.memory.utilization",
		databaseType: "redis",
		label: "Memory utilization",
		description: "Used memory divided by configured maxmemory.",
		unit: "percent",
		query:
			'100 * max(redis_memory_used_bytes{service_id="$serviceId"}) / clamp_min(max(redis_memory_max_bytes{service_id="$serviceId"}), 1)',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.memory.fragmentation",
		databaseType: "redis",
		label: "Memory fragmentation",
		description: "Redis memory fragmentation ratio.",
		unit: "count",
		query: 'max(redis_mem_fragmentation_ratio{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.operations",
		databaseType: "redis",
		label: "Operations",
		description: "Commands processed per second.",
		unit: "operations_per_second",
		query:
			'sum(rate(redis_commands_processed_total{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.commands",
		databaseType: "redis",
		label: "Commands by name",
		description: "Commands executed per second, grouped by command.",
		unit: "operations_per_second",
		query:
			'sum by (cmd) (rate(redis_commands_total{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.cache_hit_ratio",
		databaseType: "redis",
		label: "Cache hit ratio",
		description: "Keyspace hits as a percentage of hits and misses.",
		unit: "percent",
		query:
			'100 * sum(rate(redis_keyspace_hits_total{service_id="$serviceId"}[$window])) / clamp_min(sum(rate(redis_keyspace_hits_total{service_id="$serviceId"}[$window])) + sum(rate(redis_keyspace_misses_total{service_id="$serviceId"}[$window])), 0.000001)',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.keys",
		databaseType: "redis",
		label: "Keys",
		description: "Total keys reported by Redis databases.",
		unit: "count",
		query: 'sum(redis_db_keys{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.expirations",
		databaseType: "redis",
		label: "Expirations",
		description: "Expired keys per second.",
		unit: "operations_per_second",
		query:
			'sum(rate(redis_expired_keys_total{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.evictions",
		databaseType: "redis",
		label: "Evictions",
		description: "Evicted keys in the selected window.",
		unit: "count",
		query:
			'sum(increase(redis_evicted_keys_total{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.rejected_connections",
		databaseType: "redis",
		label: "Rejected connections",
		description: "Rejected connections in the selected window.",
		unit: "count",
		query:
			'sum(increase(redis_rejected_connections_total{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.network.input",
		databaseType: "redis",
		label: "Network input",
		description: "Network bytes received per second.",
		unit: "bytes_per_second",
		query:
			'sum(rate(redis_net_input_bytes_total{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.network.output",
		databaseType: "redis",
		label: "Network output",
		description: "Network bytes sent per second.",
		unit: "bytes_per_second",
		query:
			'sum(rate(redis_net_output_bytes_total{service_id="$serviceId"}[$window]))',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.persistence.last_save",
		databaseType: "redis",
		label: "Last successful save",
		description: "Seconds since the last successful RDB save.",
		unit: "seconds",
		query:
			'time() - max(redis_rdb_last_save_timestamp_seconds{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.persistence.loading",
		databaseType: "redis",
		label: "Loading dataset",
		description: "Whether Redis is currently loading a dataset.",
		unit: "boolean",
		query: 'max(redis_loading_dump_file{service_id="$serviceId"})',
		operators: allComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.replication.connected_replicas",
		databaseType: "redis",
		label: "Connected replicas",
		description: "Number of connected Redis replicas.",
		unit: "count",
		query: 'max(redis_connected_slaves{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
	{
		key: "redis.replication.lag",
		databaseType: "redis",
		label: "Replication lag",
		description: "Greatest replica lag in seconds.",
		unit: "seconds",
		query: 'max(redis_connected_slave_lag_seconds{service_id="$serviceId"})',
		operators: thresholdComparisons,
		defaultLookback: "5m",
	},
];

export const DATABASE_METRIC_CATALOG = new Map(
	DATABASE_METRICS.map((metric) => [metric.key, metric]),
);

const escapePrometheusLabel = (value: string) =>
	value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export const compileMetricQuery = (
	metric: MetricDefinition,
	serviceId: string,
	lookbackWindow: string,
) => {
	if (!/^(?:0|[1-9]\d*)(?:s|m|h|d|w)$/.test(lookbackWindow)) {
		throw new Error("Invalid Prometheus duration");
	}
	return metric.query
		.replaceAll("$serviceId", escapePrometheusLabel(serviceId))
		.replaceAll("$window", lookbackWindow);
};

const operatorMap: Record<DatabaseAlertRuleInputType["operator"], string> = {
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
	eq: "==",
	neq: "!=",
};

type AlertRuleRecord = Pick<
	typeof databaseAlertRules.$inferSelect,
	| "databaseAlertRuleId"
	| "serviceId"
	| "metricKey"
	| "operator"
	| "threshold"
	| "lookbackWindow"
	| "forDuration"
	| "severity"
	| "name"
	| "description"
>;

export const compileAlertRule = (rule: AlertRuleRecord) => {
	const metric = DATABASE_METRIC_CATALOG.get(rule.metricKey);
	if (!metric) {
		throw new Error(`Unknown database metric: ${rule.metricKey}`);
	}
	if (!metric.operators.includes(rule.operator)) {
		throw new Error(
			`Operator ${rule.operator} is not valid for ${rule.metricKey}`,
		);
	}

	const metricExpression = compileMetricQuery(
		metric,
		rule.serviceId,
		rule.lookbackWindow,
	);
	const expectedGuard =
		rule.metricKey === "postgres.up" || rule.metricKey === "redis.up"
			? `dokploy_database_expected_up{service_id="${escapePrometheusLabel(rule.serviceId)}"} == 1 and on() `
			: "";

	return {
		alert: `DokployDatabase_${rule.databaseAlertRuleId.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`,
		expr: `${expectedGuard}(${metricExpression}) ${operatorMap[rule.operator]} ${rule.threshold}`,
		for: rule.forDuration,
		labels: {
			severity: rule.severity,
			service_id: rule.serviceId,
			rule_id: rule.databaseAlertRuleId,
			managed_by: "dokploy",
		},
		annotations: {
			summary: rule.name,
			description: rule.description,
			metric_key: rule.metricKey,
		},
	};
};

export type AlertPreset = Omit<
	DatabaseAlertRuleInputType,
	"serviceId" | "notificationIds"
> & { presetKey: string };

export const DATABASE_ALERT_PRESETS: Record<DatabaseKind, AlertPreset[]> = {
	postgres: [
		{
			presetKey: "postgres-down",
			metricKey: "postgres.up",
			operator: "eq",
			threshold: 0,
			lookbackWindow: "1m",
			forDuration: "1m",
			severity: "critical",
			name: "alert-postgres-availability-critical-eq-0",
			description: "PostgreSQL has been unavailable for at least one minute.",
			enabled: false,
		},
		{
			presetKey: "postgres-connections-high",
			metricKey: "postgres.connections.utilization",
			operator: "gt",
			threshold: 80,
			lookbackWindow: "5m",
			forDuration: "5m",
			severity: "warning",
			name: "alert-postgres-connections-warning-gt-80",
			description: "More than 80% of available connections are in use.",
			enabled: false,
		},
		{
			presetKey: "postgres-deadlocks",
			metricKey: "postgres.deadlocks",
			operator: "gt",
			threshold: 0,
			lookbackWindow: "5m",
			forDuration: "0s",
			severity: "warning",
			name: "alert-postgres-deadlocks-warning-gt-0",
			description: "One or more deadlocks occurred in the last five minutes.",
			enabled: false,
		},
		{
			presetKey: "postgres-rollback-ratio",
			metricKey: "postgres.transactions.rollback_ratio",
			operator: "gt",
			threshold: 10,
			lookbackWindow: "5m",
			forDuration: "5m",
			severity: "warning",
			name: "alert-postgres-rollback-ratio-warning-gt-10",
			description: "More than 10% of transactions are rolling back.",
			enabled: false,
		},
		{
			presetKey: "postgres-cache-hit",
			metricKey: "postgres.cache_hit_ratio",
			operator: "lt",
			threshold: 90,
			lookbackWindow: "10m",
			forDuration: "10m",
			severity: "warning",
			name: "alert-postgres-cache-hit-warning-lt-90",
			description: "The cache hit ratio has remained below 90%.",
			enabled: false,
		},
		{
			presetKey: "postgres-replication-lag",
			metricKey: "postgres.replication_lag",
			operator: "gt",
			threshold: 30,
			lookbackWindow: "5m",
			forDuration: "5m",
			severity: "critical",
			name: "alert-postgres-replication-lag-critical-gt-30",
			description: "Replication lag has exceeded 30 seconds.",
			enabled: false,
		},
	],
	redis: [
		{
			presetKey: "redis-down",
			metricKey: "redis.up",
			operator: "eq",
			threshold: 0,
			lookbackWindow: "1m",
			forDuration: "1m",
			severity: "critical",
			name: "alert-redis-availability-critical-eq-0",
			description: "Redis has been unavailable for at least one minute.",
			enabled: false,
		},
		{
			presetKey: "redis-memory-high",
			metricKey: "redis.memory.utilization",
			operator: "gt",
			threshold: 80,
			lookbackWindow: "5m",
			forDuration: "5m",
			severity: "warning",
			name: "alert-redis-memory-warning-gt-80",
			description: "Redis is using more than 80% of maxmemory.",
			enabled: false,
		},
		{
			presetKey: "redis-evictions",
			metricKey: "redis.evictions",
			operator: "gt",
			threshold: 0,
			lookbackWindow: "5m",
			forDuration: "0s",
			severity: "warning",
			name: "alert-redis-evictions-warning-gt-0",
			description: "Redis evicted one or more keys in the last five minutes.",
			enabled: false,
		},
		{
			presetKey: "redis-rejected-connections",
			metricKey: "redis.rejected_connections",
			operator: "gt",
			threshold: 0,
			lookbackWindow: "5m",
			forDuration: "0s",
			severity: "warning",
			name: "alert-redis-rejected-connections-warning-gt-0",
			description: "Redis rejected one or more connections.",
			enabled: false,
		},
		{
			presetKey: "redis-blocked-clients",
			metricKey: "redis.clients.blocked",
			operator: "gt",
			threshold: 0,
			lookbackWindow: "5m",
			forDuration: "5m",
			severity: "warning",
			name: "alert-redis-blocked-clients-warning-gt-0",
			description: "One or more Redis clients have remained blocked.",
			enabled: false,
		},
		{
			presetKey: "redis-cache-hit",
			metricKey: "redis.cache_hit_ratio",
			operator: "lt",
			threshold: 80,
			lookbackWindow: "10m",
			forDuration: "10m",
			severity: "warning",
			name: "alert-redis-cache-hit-warning-lt-80",
			description: "The Redis cache hit ratio has remained below 80%.",
			enabled: false,
		},
		{
			presetKey: "redis-replication",
			metricKey: "redis.replication.lag",
			operator: "gt",
			threshold: 10,
			lookbackWindow: "5m",
			forDuration: "5m",
			severity: "critical",
			name: "alert-redis-replication-lag-critical-gt-10",
			description: "Replica lag has exceeded ten seconds.",
			enabled: false,
		},
	],
};

export const validateDatabaseAlertInput = (
	input: DatabaseAlertRuleInputType,
	databaseType: DatabaseKind,
) => {
	const metric = DATABASE_METRIC_CATALOG.get(input.metricKey);
	if (!metric || metric.databaseType !== databaseType) {
		throw new Error(
			`Metric ${input.metricKey} is not available for ${databaseType}`,
		);
	}
	if (!metric.operators.includes(input.operator)) {
		throw new Error(
			`Operator ${input.operator} is not available for ${input.metricKey}`,
		);
	}
	const requiredNamePrefix = `alert-${databaseType}-`;
	if (!input.name.startsWith(requiredNamePrefix)) {
		throw new Error(
			`Alert names for ${databaseType} databases must start with "${requiredNamePrefix}"`,
		);
	}
	return metric;
};

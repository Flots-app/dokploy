import YAML from "yaml";
import type { DatabaseKind } from "./catalog";
import { compileAlertRule, DATABASE_METRICS } from "./catalog";
import { OBSERVABILITY } from "./constants";

export type ObservableDatabase = {
	serviceId: string;
	name: string;
	databaseType: DatabaseKind;
	organizationId: string;
	serverId: string;
	projectId: string;
	environmentId: string;
};

export type AlertRuleConfig = Parameters<typeof compileAlertRule>[0];

const dashboardFor = (databaseType: DatabaseKind) => {
	const metrics = DATABASE_METRICS.filter(
		(metric) => metric.databaseType === databaseType,
	);
	return {
		annotations: { list: [] },
		editable: false,
		fiscalYearStartMonth: 0,
		graphTooltip: 1,
		id: null,
		links: [],
		liveNow: false,
		panels: metrics.map((metric, index) => ({
			datasource: { type: "prometheus", uid: "${DS_DOKPLOY_DATABASE}" },
			fieldConfig: {
				defaults: {
					unit:
						metric.unit === "percent"
							? "percent"
							: metric.unit === "bytes"
								? "bytes"
								: metric.unit === "seconds"
									? "s"
									: metric.unit === "bytes_per_second"
										? "Bps"
										: "short",
				},
				overrides: [],
			},
			gridPos: {
				h: 8,
				w: 8,
				x: (index % 3) * 8,
				y: Math.floor(index / 3) * 8,
			},
			id: index + 1,
			options: {
				legend: { displayMode: "list", placement: "bottom" },
				tooltip: { mode: "single", sort: "none" },
			},
			targets: [
				{
					expr: metric.query
						.replaceAll("$serviceId", "${service_id}")
						.replaceAll("$window", "$__rate_interval"),
					legendFormat: metric.label,
					refId: "A",
				},
			],
			title: metric.label,
			type: metric.unit === "boolean" ? "stat" : "timeseries",
		})),
		refresh: OBSERVABILITY.scrapeInterval,
		schemaVersion: 41,
		tags: ["dokploy", databaseType, "immutable"],
		templating: {
			list: [
				{
					current: { text: "", value: "" },
					hide: 2,
					label: "Service",
					name: "service_id",
					query: "",
					type: "textbox",
				},
				{
					current: {},
					hide: 2,
					label: "Datasource",
					name: "DS_DOKPLOY_DATABASE",
					query: "prometheus",
					type: "datasource",
				},
			],
		},
		time: { from: "now-1h", to: "now" },
		timezone: "browser",
		title: databaseType === "postgres" ? "Dokploy PostgreSQL" : "Dokploy Redis",
		uid: `dokploy-${databaseType}`,
		version: 1,
	};
};

export const POSTGRES_DASHBOARD = dashboardFor("postgres");
export const REDIS_DASHBOARD = dashboardFor("redis");

export const generatePrometheusConfig = ({
	alertmanagerService = OBSERVABILITY.alertmanagerService,
}: {
	alertmanagerService?: string;
} = {}) =>
	YAML.stringify({
		global: {
			scrape_interval: OBSERVABILITY.scrapeInterval,
			evaluation_interval: OBSERVABILITY.scrapeInterval,
		},
		alerting: {
			alertmanagers: [
				{
					static_configs: [
						{
							targets: [`${alertmanagerService}:9093`],
						},
					],
				},
			],
		},
		rule_files: ["/etc/prometheus/rules/database-alerts.yml"],
		scrape_configs: [
			{
				job_name: "dokploy-expected-databases",
				scrape_interval: OBSERVABILITY.scrapeInterval,
				static_configs: [
					{
						targets: ["dokploy:3000"],
					},
				],
				metrics_path: "/api/observability/expected",
				bearer_token_file: "/run/secrets/dokploy-observability-gateway-token",
			},
		],
	});

export const generateAgentConfig = ({
	publicUrl,
	serverKey,
	organizationId,
}: {
	publicUrl: string;
	serverKey: string;
	organizationId: string;
}) =>
	YAML.stringify({
		global: {
			scrape_interval: OBSERVABILITY.scrapeInterval,
			external_labels: {
				organization_id: organizationId,
				server_id: serverKey,
			},
		},
		scrape_configs: [
			{ databaseType: "postgres", port: 9187 },
			{ databaseType: "redis", port: 9121 },
		].map(({ databaseType, port }) => ({
			job_name: `dokploy-${databaseType}-exporters`,
			dockerswarm_sd_configs: [
				{
					host: "unix:///var/run/docker.sock",
					role: "tasks",
					port,
					refresh_interval: OBSERVABILITY.scrapeInterval,
				},
			],
			relabel_configs: [
				{
					source_labels: [
						"__meta_dockerswarm_service_label_dokploy_observability_exporter",
					],
					regex: "true",
					action: "keep",
				},
				{
					source_labels: ["__meta_dockerswarm_network_name"],
					regex: OBSERVABILITY.network,
					action: "keep",
				},
				{
					source_labels: [
						"__meta_dockerswarm_service_label_dokploy_observability_database_type",
					],
					regex: databaseType,
					action: "keep",
				},
				{
					source_labels: ["__meta_dockerswarm_task_desired_state"],
					regex: "running",
					action: "keep",
				},
				...[
					"organization_id",
					"server_id",
					"project_id",
					"environment_id",
					"database_type",
					"service_id",
				].map((label) => ({
					source_labels: [
						`__meta_dockerswarm_service_label_dokploy_observability_${label}`,
					],
					target_label: label,
				})),
			],
		})),
		remote_write: [
			{
				url: `${publicUrl.replace(/\/$/, "")}/api/observability/remote-write/${encodeURIComponent(serverKey)}`,
				bearer_token_file: "/run/secrets/dokploy-observability-agent-token",
				queue_config: {
					capacity: 10000,
					max_shards: 10,
					min_shards: 1,
					max_samples_per_send: 2000,
				},
			},
		],
	});

export const generateAlertmanagerConfig = () =>
	YAML.stringify({
		global: {},
		route: {
			receiver: "dokploy",
			group_by: ["service_id", "rule_id"],
			group_wait: "30s",
			group_interval: "5m",
			repeat_interval: "4h",
		},
		receivers: [
			{
				name: "dokploy",
				webhook_configs: [
					{
						url: "http://dokploy:3000/api/observability/alertmanager",
						send_resolved: true,
						http_config: {
							authorization: {
								type: "Bearer",
								credentials_file:
									"/run/secrets/dokploy-observability-alertmanager-token",
							},
						},
					},
				],
			},
		],
	});

export const generateAlertRules = (rules: AlertRuleConfig[]) =>
	YAML.stringify({
		groups: [
			{
				name: "dokploy-database-alerts",
				interval: OBSERVABILITY.scrapeInterval,
				rules: rules.map(compileAlertRule),
			},
		],
	});

const datasourceUid = (serviceId: string) =>
	`dokploy-${serviceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 40);

export const generateGrafanaDatasources = ({
	databases,
}: {
	databases: ObservableDatabase[];
}) =>
	YAML.stringify({
		apiVersion: 1,
		prune: true,
		deleteDatasources: [],
		datasources: databases.map((database) => ({
			name: `Dokploy ${database.databaseType}: ${database.name}`,
			uid: datasourceUid(database.serviceId),
			type: "prometheus",
			access: "proxy",
			url: `http://dokploy:3000/api/observability/prometheus-gateway/${encodeURIComponent(database.serviceId)}`,
			isDefault: false,
			editable: false,
			jsonData: {
				httpMethod: "POST",
				httpHeaderName1: "X-Dokploy-Observability-Token",
			},
			secureJsonData: {
				httpHeaderValue1: "$DOKPLOY_GATEWAY_TOKEN",
			},
		})),
	});

export const generateGrafanaDashboardProvider = () =>
	YAML.stringify({
		apiVersion: 1,
		providers: [
			{
				name: "Dokploy managed database dashboards",
				orgId: 1,
				folder: "Dokploy",
				type: "file",
				disableDeletion: true,
				allowUiUpdates: false,
				updateIntervalSeconds: 30,
				options: {
					path: "/var/lib/grafana/dashboards",
					foldersFromFilesStructure: false,
				},
			},
		],
	});

export const getDatasourceUid = datasourceUid;

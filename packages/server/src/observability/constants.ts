export const OBSERVABILITY_IMAGES = {
	prometheus:
		"prom/prometheus:v3.12.0@sha256:69f5241418838263316593f7274a304b095c40bcf22e57272865da91bd60a8ac",
	alertmanager:
		"prom/alertmanager:v0.32.1@sha256:51a825c2a40acc3e338fdd00d622e01ec090f72be2b3ea46be0839cd47a4d286",
	grafana:
		"grafana/grafana:13.1.0@sha256:121a7a9ece6dc10b969f1f96eed64b4f07dfac0d0b8abc070f7cb83bbde86f63",
	postgresExporter:
		"prometheuscommunity/postgres-exporter:v0.19.1@sha256:e96064f876226d94bb6ce48a4c4b3dd76edba91168ec1ab024e5c4b959310b0f",
	redisExporter:
		"oliver006/redis_exporter:v1.84.0@sha256:7ef8e9c26638158fa4e7ad60df8c7e53d1919986753d6c1d2d1876b6ec38d87b",
} as const;

export const OBSERVABILITY = {
	stackRevision: 1,
	scrapeInterval: "15s",
	retention: "15d",
	eventRetentionDays: 30,
	network: "dokploy-network",
	prometheusService: "dokploy-observability-prometheus",
	alertmanagerService: "dokploy-observability-alertmanager",
	grafanaService: "dokploy-observability-grafana",
	agentService: "dokploy-observability-agent",
	prometheusVolume: "dokploy-observability-prometheus-data",
	grafanaVolume: "dokploy-observability-grafana-data",
	agentWalVolume: "dokploy-observability-agent-wal",
} as const;

export const getOrganizationObservabilityResources = (
	organizationId: string,
) => {
	const scope = organizationId
		.toLowerCase()
		.replaceAll(/[^a-z0-9-]/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, 24)
		.replaceAll(/-+$/g, "");
	if (!scope) throw new Error("Invalid observability organization scope");
	return {
		prometheusService: `${OBSERVABILITY.prometheusService}-${scope}`,
		alertmanagerService: `${OBSERVABILITY.alertmanagerService}-${scope}`,
		grafanaService: `${OBSERVABILITY.grafanaService}-${scope}`,
		prometheusVolume: `${OBSERVABILITY.prometheusVolume}-${scope}`,
		grafanaVolume: `${OBSERVABILITY.grafanaVolume}-${scope}`,
	};
};

const upstreamOverride = (value: string | undefined) =>
	value?.trim().replace(/\/+$/, "") || null;

export const getObservabilityPrometheusUrl = (organizationId: string) =>
	upstreamOverride(process.env.DOKPLOY_OBSERVABILITY_PROMETHEUS_URL) ??
	`http://${getOrganizationObservabilityResources(organizationId).prometheusService}:9090`;

export const getObservabilityGrafanaUrl = (organizationId: string) =>
	upstreamOverride(process.env.DOKPLOY_OBSERVABILITY_GRAFANA_URL) ??
	`http://${getOrganizationObservabilityResources(organizationId).grafanaService}:3000`;

export const OBSERVABILITY_COMMON_LABELS = [
	"organization_id",
	"server_id",
	"project_id",
	"environment_id",
	"database_type",
	"service_id",
] as const;

export type ObservabilityCommonLabel =
	(typeof OBSERVABILITY_COMMON_LABELS)[number];

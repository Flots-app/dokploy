import {
	generateAgentConfig,
	generateAlertmanagerConfig,
	generateGrafanaDashboardProvider,
	generateGrafanaDatasources,
	generatePrometheusConfig,
	POSTGRES_DASHBOARD,
	REDIS_DASHBOARD,
} from "@dokploy/server/observability/config";
import {
	getObservabilityGrafanaUrl,
	getObservabilityPrometheusUrl,
	getOrganizationObservabilityResources,
	OBSERVABILITY,
	OBSERVABILITY_IMAGES,
} from "@dokploy/server/observability/constants";
import { describe, expect, it } from "vitest";

const database = {
	serviceId: "postgres-1",
	name: "Main",
	databaseType: "postgres" as const,
	organizationId: "org-1",
	serverId: "server-1",
	projectId: "project-1",
	environmentId: "env-1",
};

describe("pinned observability images", () => {
	it("pins every image by requested tag and sha256 digest", () => {
		expect(OBSERVABILITY_IMAGES.prometheus).toMatch(
			/^prom\/prometheus:v3\.12\.0@sha256:[a-f0-9]{64}$/,
		);
		expect(OBSERVABILITY_IMAGES.alertmanager).toMatch(
			/^prom\/alertmanager:v0\.32\.1@sha256:[a-f0-9]{64}$/,
		);
		expect(OBSERVABILITY_IMAGES.grafana).toMatch(
			/^grafana\/grafana:13\.1\.0@sha256:[a-f0-9]{64}$/,
		);
		expect(OBSERVABILITY_IMAGES.postgresExporter).toMatch(
			/^prometheuscommunity\/postgres-exporter:v0\.19\.1@sha256:[a-f0-9]{64}$/,
		);
		expect(OBSERVABILITY_IMAGES.redisExporter).toMatch(
			/^oliver006\/redis_exporter:v1\.84\.0@sha256:[a-f0-9]{64}$/,
		);
	});
});

describe("portable provisioning", () => {
	it("isolates central services and persistent volumes by organization", () => {
		const first = getOrganizationObservabilityResources("org-1");
		const second = getOrganizationObservabilityResources("org-2");
		expect(first.prometheusService).not.toBe(second.prometheusService);
		expect(first.alertmanagerService).not.toBe(second.alertmanagerService);
		expect(first.grafanaService).not.toBe(second.grafanaService);
		expect(first.prometheusVolume).not.toBe(second.prometheusVolume);
		expect(first.grafanaVolume).not.toBe(second.grafanaVolume);
	});

	it("generates DNS-safe Swarm service names from URL-safe organization ids", () => {
		const resources = getOrganizationObservabilityResources(
			"fK84i9oCWBUVjdLlGr1G_",
		);

		for (const serviceName of [
			resources.prometheusService,
			resources.alertmanagerService,
			resources.grafanaService,
		]) {
			expect(serviceName).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
			expect(serviceName.length).toBeLessThanOrEqual(63);
		}
	});

	it("supports explicit internal upstreams for local development", () => {
		const previousPrometheus = process.env.DOKPLOY_OBSERVABILITY_PROMETHEUS_URL;
		const previousGrafana = process.env.DOKPLOY_OBSERVABILITY_GRAFANA_URL;
		try {
			process.env.DOKPLOY_OBSERVABILITY_PROMETHEUS_URL =
				"http://127.0.0.1:19090/";
			process.env.DOKPLOY_OBSERVABILITY_GRAFANA_URL = "http://127.0.0.1:13000/";

			expect(getObservabilityPrometheusUrl("org-1")).toBe(
				"http://127.0.0.1:19090",
			);
			expect(getObservabilityGrafanaUrl("org-1")).toBe(
				"http://127.0.0.1:13000",
			);
		} finally {
			if (previousPrometheus === undefined) {
				delete process.env.DOKPLOY_OBSERVABILITY_PROMETHEUS_URL;
			} else {
				process.env.DOKPLOY_OBSERVABILITY_PROMETHEUS_URL = previousPrometheus;
			}
			if (previousGrafana === undefined) {
				delete process.env.DOKPLOY_OBSERVABILITY_GRAFANA_URL;
			} else {
				process.env.DOKPLOY_OBSERVABILITY_GRAFANA_URL = previousGrafana;
			}
		}
	});

	it("configures Prometheus for 15 day retention inputs and authenticated expected state", () => {
		const config = generatePrometheusConfig();
		expect(OBSERVABILITY.retention).toBe("15d");
		expect(config).toContain("scrape_interval: 15s");
		expect(config).toContain("bearer_token_file:");
		expect(config).toContain("database-alerts.yml");
	});

	it("configures agent discovery, WAL Remote Write, labels, and token file", () => {
		const config = generateAgentConfig({
			publicUrl: "https://dokploy.example.com",
			serverKey: "server-1",
			organizationId: "org-1",
		});
		expect(config).toContain("dockerswarm_sd_configs");
		expect(config).toContain("port: 9187");
		expect(config).toContain("port: 9121");
		expect(config).toContain("__meta_dockerswarm_network_name");
		expect(config).toContain(OBSERVABILITY.network);
		expect(config).toContain(
			"https://dokploy.example.com/api/observability/remote-write/server-1",
		);
		expect(config).toContain("bearer_token_file:");
		for (const label of [
			"organization_id",
			"server_id",
			"project_id",
			"environment_id",
			"database_type",
			"service_id",
		]) {
			expect(config).toContain(label);
		}
		expect(config).not.toContain("super-secret");
	});

	it("configures Alertmanager grouping, timing, resolutions, and secret auth", () => {
		const config = generateAlertmanagerConfig();
		expect(config).toContain("group_wait: 30s");
		expect(config).toContain("repeat_interval: 4h");
		expect(config).toContain("send_resolved: true");
		expect(config).toContain("credentials_file:");
		expect(config).toContain("service_id");
		expect(config).toContain("rule_id");
	});

	it("creates one immutable logical datasource per database without embedding a token", () => {
		const config = generateGrafanaDatasources({ databases: [database] });
		expect(config).toContain("prometheus-gateway/postgres-1");
		expect(config).toContain("editable: false");
		expect(config).toContain("prune: true");
		expect(config).toContain("$DOKPLOY_GATEWAY_TOKEN");
		expect(config).not.toContain("super-secret");
		const provider = generateGrafanaDashboardProvider();
		expect(provider).toContain("disableDeletion: true");
		expect(provider).toContain("allowUiUpdates: false");
	});

	it("ships immutable PostgreSQL and Redis dashboards", () => {
		expect(POSTGRES_DASHBOARD).toMatchObject({
			editable: false,
			uid: "dokploy-postgres",
		});
		expect(REDIS_DASHBOARD).toMatchObject({
			editable: false,
			uid: "dokploy-redis",
		});
		expect(POSTGRES_DASHBOARD.panels.length).toBeGreaterThan(10);
		expect(REDIS_DASHBOARD.panels.length).toBeGreaterThan(15);
		expect(POSTGRES_DASHBOARD.templating.list[0]).toMatchObject({
			name: "service_id",
			type: "textbox",
			hide: 2,
		});
		expect(REDIS_DASHBOARD.templating.list[0]).toMatchObject({
			name: "service_id",
			type: "textbox",
			hide: 2,
		});
	});
});

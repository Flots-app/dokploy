import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	generateAgentConfig,
	generateAlertmanagerConfig,
	generateAlertRules,
	generatePrometheusConfig,
} from "@dokploy/server/observability/config";
import { OBSERVABILITY_IMAGES } from "@dokploy/server/observability/constants";
import { validateObservabilityArtifacts } from "@dokploy/server/observability/orchestration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runIntegration = process.env.DOKPLOY_OBSERVABILITY_INTEGRATION === "true";
const exec = promisify(execFile);
const suffix = process.pid.toString(36);
const names = {
	network: `dokploy-observability-test-${suffix}`,
	postgres: `dokploy-observability-postgres-${suffix}`,
	redis: `dokploy-observability-redis-${suffix}`,
	postgresExporter: `dokploy-observability-pg-exporter-${suffix}`,
	redisExporter: `dokploy-observability-redis-exporter-${suffix}`,
	prometheus: `dokploy-observability-prometheus-${suffix}`,
	agent: `dokploy-observability-agent-${suffix}`,
	grafana: `dokploy-observability-grafana-${suffix}`,
};
const containers = Object.values(names).filter(
	(name) => name !== names.network,
);
const password = "dokploy-integration-password";
let directory = "";
let prometheusPort = 0;
let grafanaPort = 0;

const docker = (...args: string[]) =>
	exec("docker", args, { maxBuffer: 10 * 1024 * 1024 });

const start = (...args: string[]) =>
	docker("run", "--detach", "--pull", "missing", ...args);

describe.runIf(runIntegration)(
	"managed database observability Docker integration",
	() => {
		beforeAll(async () => {
			directory = await mkdtemp(
				path.join(tmpdir(), "dokploy-observability-integration-"),
			);
			const postgresPassword = path.join(directory, "postgres-password");
			const redisPassword = path.join(directory, "redis-password");
			const redisConfig = path.join(directory, "redis.conf");
			const prometheusConfig = path.join(directory, "prometheus.yml");
			const agentConfig = path.join(directory, "agent.yml");
			await Promise.all([
				writeFile(postgresPassword, password),
				writeFile(
					redisPassword,
					JSON.stringify({
						[`redis://${names.redis}:6379`]: password,
					}),
				),
				writeFile(redisConfig, `requirepass ${password}\n`),
				writeFile(
					prometheusConfig,
					`global:
  scrape_interval: 15s
`,
				),
				writeFile(
					agentConfig,
					`global:
  scrape_interval: 15s
scrape_configs:
  - job_name: postgres
    static_configs:
      - targets: ["${names.postgresExporter}:9187"]
        labels:
          organization_id: org-integration
          server_id: local
          project_id: project-integration
          environment_id: environment-integration
          database_type: postgres
          service_id: postgres-integration
  - job_name: redis
    static_configs:
      - targets: ["${names.redisExporter}:9121"]
        labels:
          organization_id: org-integration
          server_id: local
          project_id: project-integration
          environment_id: environment-integration
          database_type: redis
          service_id: redis-integration
remote_write:
  - url: http://${names.prometheus}:9090/api/v1/write
`,
				),
			]);
			await Promise.all(
				[
					postgresPassword,
					redisPassword,
					redisConfig,
					prometheusConfig,
					agentConfig,
				].map((file) => chmod(file, 0o644)),
			);

			await docker("network", "create", names.network);
			await start(
				"--name",
				names.postgres,
				"--network",
				names.network,
				"--mount",
				`type=bind,src=${postgresPassword},dst=/run/secrets/postgres-password,readonly`,
				"--env",
				"POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password",
				"postgres:13",
			);
			await start(
				"--name",
				names.redis,
				"--network",
				names.network,
				"--mount",
				`type=bind,src=${redisConfig},dst=/run/secrets/redis.conf,readonly`,
				"redis:7",
				"redis-server",
				"/run/secrets/redis.conf",
			);
			await start(
				"--name",
				names.postgresExporter,
				"--network",
				names.network,
				"--mount",
				`type=bind,src=${postgresPassword},dst=/run/secrets/postgres-password,readonly`,
				"--env",
				`DATA_SOURCE_URI=${names.postgres}:5432/postgres?sslmode=disable`,
				"--env",
				"DATA_SOURCE_USER=postgres",
				"--env",
				"DATA_SOURCE_PASS_FILE=/run/secrets/postgres-password",
				OBSERVABILITY_IMAGES.postgresExporter,
			);
			await start(
				"--name",
				names.redisExporter,
				"--network",
				names.network,
				"--mount",
				`type=bind,src=${redisPassword},dst=/run/secrets/redis-password,readonly`,
				"--env",
				`REDIS_ADDR=redis://${names.redis}:6379`,
				"--env",
				"REDIS_PASSWORD_FILE=/run/secrets/redis-password",
				OBSERVABILITY_IMAGES.redisExporter,
			);
			await start(
				"--name",
				names.prometheus,
				"--network",
				names.network,
				"--publish",
				"127.0.0.1::9090",
				"--mount",
				`type=bind,src=${prometheusConfig},dst=/etc/prometheus/prometheus.yml,readonly`,
				OBSERVABILITY_IMAGES.prometheus,
				"--config.file=/etc/prometheus/prometheus.yml",
				"--web.enable-remote-write-receiver",
			);
			const port = await docker("port", names.prometheus, "9090/tcp");
			prometheusPort = Number.parseInt(
				port.stdout.trim().split(":").at(-1) ?? "0",
				10,
			);
			await start(
				"--name",
				names.agent,
				"--network",
				names.network,
				"--mount",
				`type=bind,src=${agentConfig},dst=/etc/prometheus/prometheus.yml,readonly`,
				OBSERVABILITY_IMAGES.prometheus,
				"--config.file=/etc/prometheus/prometheus.yml",
				"--storage.agent.path=/prometheus",
				"--agent",
			);
			await start(
				"--name",
				names.grafana,
				"--network",
				names.network,
				"--publish",
				"127.0.0.1::3000",
				"--env",
				"GF_SERVER_ROOT_URL=http://localhost/api/observability/grafana",
				"--env",
				"GF_SERVER_SERVE_FROM_SUB_PATH=true",
				"--env",
				"GF_AUTH_PROXY_ENABLED=true",
				"--env",
				"GF_AUTH_PROXY_HEADER_NAME=X-Grafana-User",
				"--env",
				"GF_AUTH_PROXY_AUTO_SIGN_UP=true",
				"--env",
				"GF_AUTH_DISABLE_LOGIN_FORM=true",
				"--env",
				"GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer",
				"--env",
				"GF_USERS_ALLOW_SIGN_UP=false",
				OBSERVABILITY_IMAGES.grafana,
			);
			const grafanaPublishedPort = await docker(
				"port",
				names.grafana,
				"3000/tcp",
			);
			grafanaPort = Number.parseInt(
				grafanaPublishedPort.stdout.trim().split(":").at(-1) ?? "0",
				10,
			);
		}, 120_000);

		afterAll(async () => {
			for (const container of containers) {
				await docker("rm", "--force", container).catch(() => undefined);
			}
			await docker("network", "rm", names.network).catch(() => undefined);
			if (directory) await rm(directory, { recursive: true, force: true });
		}, 60_000);

		it("receives PostgreSQL and Redis metrics within four scrape intervals", async () => {
			const deadline = Date.now() + 60_000;
			let postgresUp = false;
			let redisUp = false;
			while (Date.now() < deadline && (!postgresUp || !redisUp)) {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				for (const [query, assign] of [
					[
						'pg_up{service_id="postgres-integration"}',
						(value: boolean) => {
							postgresUp = value;
						},
					],
					[
						'redis_up{service_id="redis-integration"}',
						(value: boolean) => {
							redisUp = value;
						},
					],
				] as const) {
					const response = await fetch(
						`http://127.0.0.1:${prometheusPort}/api/v1/query?query=${encodeURIComponent(query)}`,
					).catch(() => null);
					if (!response?.ok) continue;
					const payload = (await response.json()) as {
						data?: { result?: unknown[] };
					};
					assign((payload.data?.result?.length ?? 0) > 0);
				}
			}
			expect(postgresUp).toBe(true);
			expect(redisUp).toBe(true);
		}, 65_000);

		it("does not expose database passwords in exporter or agent inspect", async () => {
			for (const container of [
				names.postgresExporter,
				names.redisExporter,
				names.agent,
			]) {
				const inspect = await docker("inspect", container);
				expect(inspect.stdout).not.toContain(password);
			}
		});

		it("opens Grafana through Auth Proxy under the Dokploy subpath without a second login", async () => {
			const deadline = Date.now() + 30_000;
			let response: Response | null = null;
			while (Date.now() < deadline && !response?.ok) {
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				response = await fetch(
					`http://127.0.0.1:${grafanaPort}/api/observability/grafana/api/user`,
					{ headers: { "X-Grafana-User": "integration@example.com" } },
				).catch(() => null);
			}
			expect(response?.status).toBe(200);
			const organizations = await fetch(
				`http://127.0.0.1:${grafanaPort}/api/observability/grafana/api/user/orgs`,
				{ headers: { "X-Grafana-User": "integration@example.com" } },
			);
			expect(organizations.status).toBe(200);
			const memberships = (await organizations.json()) as Array<{
				role?: string;
			}>;
			expect(memberships[0]?.role).toBe("Viewer");
		}, 35_000);

		it("validates generated Prometheus, agent, rule, and Alertmanager artifacts with pinned tools", async () => {
			await validateObservabilityArtifacts({
				prometheus: generatePrometheusConfig(),
				rules: generateAlertRules([
					{
						databaseAlertRuleId: "integration-rule",
						serviceId: "postgres-integration",
						metricKey: "postgres.up",
						operator: "eq",
						threshold: 0,
						lookbackWindow: "1m",
						forDuration: "1m",
						severity: "critical",
						name: "PostgreSQL integration alert",
						description: "PostgreSQL is unavailable",
					},
				]),
				alertmanager: generateAlertmanagerConfig(),
				agent: generateAgentConfig({
					publicUrl: "https://dokploy.example.com",
					serverKey: "integration-server",
					organizationId: "integration-organization",
				}),
			});
		}, 120_000);

		it("suppresses intentional stops and fires only after sustained unavailability", async () => {
			const rulesPath = path.join(directory, "semantic-rules.yml");
			const testsPath = path.join(directory, "semantic-rules.test.yml");
			await Promise.all([
				writeFile(
					rulesPath,
					generateAlertRules([
						{
							databaseAlertRuleId: "semantic-rule",
							serviceId: "postgres-integration",
							metricKey: "postgres.up",
							operator: "eq",
							threshold: 0,
							lookbackWindow: "1m",
							forDuration: "1m",
							severity: "critical",
							name: "PostgreSQL semantic alert",
							description: "PostgreSQL stayed unavailable",
						},
					]),
					{ mode: 0o644 },
				),
				writeFile(
					testsPath,
					`rule_files:
  - semantic-rules.yml
evaluation_interval: 15s
tests:
  - name: intentional stop is suppressed
    interval: 15s
    input_series:
      - series: 'dokploy_database_expected_up{service_id="postgres-integration"}'
        values: '0x12'
      - series: 'pg_up{service_id="postgres-integration"}'
        values: '0x12'
    alert_rule_test:
      - eval_time: 2m
        alertname: DokployDatabase_semantic_rule
        exp_alerts: []
  - name: sustained unexpected outage fires
    interval: 15s
    input_series:
      - series: 'dokploy_database_expected_up{service_id="postgres-integration"}'
        values: '1x12'
      - series: 'pg_up{service_id="postgres-integration"}'
        values: '0x12'
    alert_rule_test:
      - eval_time: 2m
        alertname: DokployDatabase_semantic_rule
        exp_alerts:
          - exp_labels:
              managed_by: dokploy
              rule_id: semantic-rule
              service_id: postgres-integration
              severity: critical
            exp_annotations:
              description: PostgreSQL stayed unavailable
              metric_key: postgres.up
              summary: PostgreSQL semantic alert
`,
					{ mode: 0o644 },
				),
			]);
			await docker(
				"run",
				"--rm",
				"--entrypoint",
				"/bin/promtool",
				"--mount",
				`type=bind,src=${directory},dst=/validation,readonly`,
				OBSERVABILITY_IMAGES.prometheus,
				"test",
				"rules",
				"/validation/semantic-rules.test.yml",
			);
		}, 60_000);
	},
);

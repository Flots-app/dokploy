import { createHash, createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Dockerode from "dockerode";
import type { CreateServiceOptions, NetworkAttachmentConfig } from "dockerode";
import { betterAuthSecret } from "../lib/auth-secret";
import { spawnAsync } from "../utils/process/spawnAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import type { DatabaseKind } from "./catalog";
import {
	type AlertRuleConfig,
	generateAgentConfig,
	generateAlertmanagerConfig,
	generateAlertRules,
	generateGrafanaDashboardProvider,
	generateGrafanaDatasources,
	generatePrometheusConfig,
	type ObservableDatabase,
	POSTGRES_DASHBOARD,
	REDIS_DASHBOARD,
} from "./config";
import {
	getOrganizationObservabilityResources,
	OBSERVABILITY,
	OBSERVABILITY_IMAGES,
} from "./constants";

type DockerClient = Dockerode;

type DatabaseDeployment = ObservableDatabase & {
	appName: string;
	databaseName?: string;
	databaseUser?: string;
	databasePassword: string;
};

type DockerConfigRef = {
	ConfigID: string;
	ConfigName: string;
	File: {
		Name: string;
		UID: string;
		GID: string;
		Mode: number;
	};
};

type DockerSecretRef = {
	SecretID: string;
	SecretName: string;
	File: {
		Name: string;
		UID: string;
		GID: string;
		Mode: number;
	};
};

const shortHash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex").slice(0, 16);

const shortSecretHash = (name: string, value: string) =>
	createHmac("sha256", betterAuthSecret)
		.update(name)
		.update("\0")
		.update(value)
		.digest("hex")
		.slice(0, 16);

const safeName = (value: string) =>
	value
		.toLowerCase()
		.replaceAll(/[^a-z0-9_.-]/g, "-")
		// Versioned Docker configs and secrets append "-" plus a 16-character
		// content hash. Keep the complete resource name within Swarm's
		// 64-character limit.
		.slice(0, 47);

const swarmServiceName = (prefix: string, scope: string) => {
	const maxScopeLength = 63 - prefix.length - 1;
	const normalizedScope = scope
		.toLowerCase()
		.replaceAll(/[^a-z0-9-]/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, maxScopeLength)
		.replaceAll(/-+$/g, "");
	if (!normalizedScope) {
		throw new Error("Invalid observability Swarm service scope");
	}
	return `${prefix}-${normalizedScope}`;
};

const exactNamed = <
	T extends {
		Spec?: { Name?: string };
		Name?: string;
		ID?: string;
		Id?: string;
	},
>(
	items: T[],
	name: string,
) => items.find((item) => (item.Spec?.Name ?? item.Name) === name);

const isDockerNotFound = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"statusCode" in error &&
	error.statusCode === 404;

const ensureNetwork = async (docker: DockerClient) => {
	const existing = exactNamed(
		await docker.listNetworks({
			filters: { name: [OBSERVABILITY.network] },
		}),
		OBSERVABILITY.network,
	);
	if (existing) return existing.Id;
	const created = await docker.createNetwork({
		Name: OBSERVABILITY.network,
		Driver: "overlay",
		Attachable: true,
		CheckDuplicate: true,
	});
	return created.id;
};

const ensureVolume = async (docker: DockerClient, name: string) => {
	try {
		await docker.getVolume(name).inspect();
	} catch (error) {
		if (!isDockerNotFound(error)) throw error;
		await docker.createVolume({
			Name: name,
			Labels: {
				"dokploy.observability.managed": "true",
			},
		});
	}
};

const createVersionedConfig = async ({
	docker,
	name,
	content,
	target,
	mode = 0o444,
}: {
	docker: DockerClient;
	name: string;
	content: string;
	target: string;
	mode?: number;
}): Promise<DockerConfigRef> => {
	const versionedName = `${safeName(name)}-${shortHash(`${name}\0${content}`)}`;
	const configs = await docker.listConfigs({
		filters: { name: [versionedName] },
	});
	let existing = exactNamed(configs, versionedName);
	if (!existing) {
		const created = await docker.createConfig({
			Name: versionedName,
			Data: Buffer.from(content).toString("base64"),
			Labels: {
				"dokploy.observability.managed": "true",
				"dokploy.observability.logical-name": name,
			},
		});
		// Dockerode returns a Config handle from createConfig(), not the raw
		// Engine API response.
		existing = await created.inspect();
	}
	const id = existing?.ID;
	if (!id) throw new Error(`Docker config ${versionedName} has no id`);
	return {
		ConfigID: id,
		ConfigName: versionedName,
		File: { Name: target, UID: "65534", GID: "65534", Mode: mode },
	};
};

const createVersionedSecret = async ({
	docker,
	name,
	content,
	target,
}: {
	docker: DockerClient;
	name: string;
	content: string;
	target: string;
}): Promise<DockerSecretRef> => {
	const versionedName = `${safeName(name)}-${shortSecretHash(name, content)}`;
	const secrets = await docker.listSecrets({
		filters: { name: [versionedName] },
	});
	let existing = exactNamed(secrets, versionedName);
	if (!existing) {
		const created = await docker.createSecret({
			Name: versionedName,
			Data: Buffer.from(content).toString("base64"),
			Labels: {
				"dokploy.observability.managed": "true",
				"dokploy.observability.logical-name": name,
			},
		});
		// Dockerode returns a Secret handle from createSecret(), not the raw
		// Engine API response.
		existing = await created.inspect();
	}
	const id = existing?.ID;
	if (!id) throw new Error(`Docker secret ${versionedName} has no id`);
	return {
		SecretID: id,
		SecretName: versionedName,
		// Swarm secrets are mounted only into the selected container. Read-only
		// mode keeps them usable by the distinct non-root UIDs of Prometheus,
		// Grafana, and the two exporters without copying values into env/config.
		File: { Name: target, UID: "0", GID: "0", Mode: 0o444 },
	};
};

const ensureService = async (
	docker: DockerClient,
	settings: CreateServiceOptions,
) => {
	const name = settings.Name;
	if (!name) throw new Error("Managed service must have a name");
	const service = docker.getService(name);
	let inspect: Dockerode.Service;
	try {
		inspect = await service.inspect();
	} catch (error) {
		if (!isDockerNotFound(error)) throw error;
		await docker.createService(settings);
		return;
	}
	const version = inspect.Version?.Index;
	const currentTask = inspect.Spec?.TaskTemplate;
	if (version === undefined || !currentTask) {
		throw new Error(`Managed service ${name} has an invalid Swarm spec`);
	}
	await service.update({
		version,
		...settings,
		TaskTemplate: {
			...settings.TaskTemplate,
			ForceUpdate: (currentTask.ForceUpdate ?? 0) + 1,
		},
	});
};

const removeServiceIfPresent = async (
	docker: DockerClient,
	serviceName: string,
) => {
	try {
		await docker.getService(serviceName).remove();
	} catch (error) {
		if (!isDockerNotFound(error)) throw error;
	}
};

const cleanupUnusedManagedArtifacts = async (docker: DockerClient) => {
	const services = await docker.listServices();
	const usedSecretIds = new Set<string>();
	const usedConfigIds = new Set<string>();
	for (const service of services) {
		const task = service.Spec?.TaskTemplate;
		const container =
			task && "ContainerSpec" in task ? task.ContainerSpec : undefined;
		for (const secret of container?.Secrets ?? []) {
			if (secret.SecretID) usedSecretIds.add(secret.SecretID);
		}
		for (const config of container?.Configs ?? []) {
			if (config.ConfigID) usedConfigIds.add(config.ConfigID);
		}
	}

	const [secrets, configs] = await Promise.all([
		docker.listSecrets({
			filters: { label: ["dokploy.observability.managed=true"] },
		}),
		docker.listConfigs({
			filters: { label: ["dokploy.observability.managed=true"] },
		}),
	]);
	await Promise.all([
		...secrets.map(async (secret: { ID?: string }) => {
			if (!secret.ID || usedSecretIds.has(secret.ID)) return;
			try {
				await docker.getSecret(secret.ID).remove();
			} catch {
				// A retiring Swarm task may still hold the previous version.
			}
		}),
		...configs.map(async (config: { ID?: string }) => {
			if (!config.ID || usedConfigIds.has(config.ID)) return;
			try {
				await docker.getConfig(config.ID).remove();
			} catch {
				// Retry on the next reconciliation after old tasks exit.
			}
		}),
	]);
};

const validatePrometheusArtifacts = async ({
	prometheus,
	rules,
}: {
	prometheus: string;
	rules: string;
}) => {
	const directory = await mkdtemp(
		path.join(tmpdir(), "dokploy-observability-"),
	);
	try {
		const configPath = path.join(directory, "prometheus.yml");
		const rulesPath = path.join(directory, "database-alerts.yml");
		const tokenPath = path.join(directory, "gateway-token");
		await chmod(directory, 0o755);
		await Promise.all([
			writeFile(rulesPath, rules, { mode: 0o644 }),
			writeFile(tokenPath, "validation-only", { mode: 0o444 }),
		]);

		await spawnAsync("docker", [
			"run",
			"--rm",
			"--entrypoint",
			"/bin/promtool",
			"-v",
			`${directory}:/validation:ro`,
			OBSERVABILITY_IMAGES.prometheus,
			"check",
			"rules",
			"/validation/database-alerts.yml",
		]);
		// Runtime paths are immutable Docker configs/secrets. Point the
		// validation copy at harmless temporary files so promtool can open them.
		await writeFile(
			configPath,
			prometheus
				.replace(
					"/etc/prometheus/rules/database-alerts.yml",
					"/validation/database-alerts.yml",
				)
				.replace(
					"/run/secrets/dokploy-observability-gateway-token",
					"/validation/gateway-token",
				),
			{ mode: 0o644 },
		);
		await spawnAsync("docker", [
			"run",
			"--rm",
			"--entrypoint",
			"/bin/promtool",
			"-v",
			`${directory}:/validation:ro`,
			OBSERVABILITY_IMAGES.prometheus,
			"check",
			"config",
			"/validation/prometheus.yml",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const validateAlertmanagerArtifact = async (alertmanager: string) => {
	const directory = await mkdtemp(path.join(tmpdir(), "dokploy-alertmanager-"));
	try {
		const configPath = path.join(directory, "alertmanager.yml");
		const tokenPath = path.join(directory, "alert-token");
		await chmod(directory, 0o755);
		await Promise.all([
			writeFile(
				configPath,
				alertmanager.replace(
					"/run/secrets/dokploy-observability-alertmanager-token",
					"/validation/alert-token",
				),
				{ mode: 0o644 },
			),
			writeFile(tokenPath, "validation-only", { mode: 0o444 }),
		]);
		await spawnAsync("docker", [
			"run",
			"--rm",
			"--entrypoint",
			"/bin/amtool",
			"-v",
			`${directory}:/validation:ro`,
			OBSERVABILITY_IMAGES.alertmanager,
			"check-config",
			"/validation/alertmanager.yml",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const validateAgentArtifact = async (agent: string) => {
	const directory = await mkdtemp(path.join(tmpdir(), "dokploy-agent-"));
	try {
		const configPath = path.join(directory, "agent.yml");
		const tokenPath = path.join(directory, "agent-token");
		await chmod(directory, 0o755);
		await Promise.all([
			writeFile(
				configPath,
				agent.replace(
					"/run/secrets/dokploy-observability-agent-token",
					"/validation/agent-token",
				),
				{ mode: 0o644 },
			),
			writeFile(tokenPath, "validation-only", { mode: 0o444 }),
		]);
		await spawnAsync("docker", [
			"run",
			"--rm",
			"--entrypoint",
			"/bin/promtool",
			"-v",
			`${directory}:/validation:ro`,
			OBSERVABILITY_IMAGES.prometheus,
			"check",
			"config",
			"/validation/agent.yml",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

export const validateObservabilityArtifacts = async ({
	prometheus,
	rules,
	alertmanager,
	agent,
}: {
	prometheus?: string;
	rules?: string;
	alertmanager?: string;
	agent?: string;
}) => {
	const validations: Promise<void>[] = [];
	if (prometheus !== undefined || rules !== undefined) {
		if (prometheus === undefined || rules === undefined) {
			throw new Error(
				"Prometheus configuration and rule artifacts must be validated together",
			);
		}
		validations.push(validatePrometheusArtifacts({ prometheus, rules }));
	}
	if (alertmanager !== undefined) {
		validations.push(validateAlertmanagerArtifact(alertmanager));
	}
	if (agent !== undefined) {
		validations.push(validateAgentArtifact(agent));
	}
	await Promise.all(validations);
};

export const reconcileCentralObservabilityStack = async ({
	organizationId,
	publicUrl,
	gatewayToken,
	alertmanagerToken,
	databases,
	rules,
}: {
	organizationId: string;
	publicUrl: string;
	gatewayToken: string;
	alertmanagerToken: string;
	databases: ObservableDatabase[];
	rules: AlertRuleConfig[];
}) => {
	const docker = await getRemoteDocker();
	const resources = getOrganizationObservabilityResources(organizationId);
	const networkId = await ensureNetwork(docker);
	await Promise.all([
		ensureVolume(docker, resources.prometheusVolume),
		ensureVolume(docker, resources.grafanaVolume),
	]);

	const prometheusContent = generatePrometheusConfig({
		alertmanagerService: resources.alertmanagerService,
	});
	const rulesContent = generateAlertRules(rules);
	const alertmanagerContent = generateAlertmanagerConfig();
	await validateObservabilityArtifacts({
		prometheus: prometheusContent,
		rules: rulesContent,
		alertmanager: alertmanagerContent,
	});

	const [
		prometheusConfig,
		prometheusRules,
		alertmanagerConfig,
		grafanaDatasources,
		grafanaProvider,
		postgresDashboard,
		redisDashboard,
		gatewaySecret,
		alertmanagerSecret,
	] = await Promise.all([
		createVersionedConfig({
			docker,
			name: `dokploy-observability-prometheus-${organizationId}`,
			content: prometheusContent,
			target: "/etc/prometheus/prometheus.yml",
		}),
		createVersionedConfig({
			docker,
			name: `dokploy-observability-rules-${organizationId}`,
			content: rulesContent,
			target: "/etc/prometheus/rules/database-alerts.yml",
		}),
		createVersionedConfig({
			docker,
			name: `dokploy-observability-alertmanager-${organizationId}`,
			content: alertmanagerContent,
			target: "/etc/alertmanager/alertmanager.yml",
		}),
		createVersionedConfig({
			docker,
			name: `dokploy-observability-grafana-datasources-${organizationId}`,
			content: generateGrafanaDatasources({ databases }),
			target: "/etc/grafana/provisioning/datasources/dokploy.yml",
		}),
		createVersionedConfig({
			docker,
			name: `dokploy-observability-grafana-provider-${organizationId}`,
			content: generateGrafanaDashboardProvider(),
			target: "/etc/grafana/provisioning/dashboards/dokploy.yml",
		}),
		createVersionedConfig({
			docker,
			name: `dokploy-observability-postgres-dashboard-${organizationId}`,
			content: JSON.stringify(POSTGRES_DASHBOARD),
			target: "/var/lib/grafana/dashboards/postgres.json",
		}),
		createVersionedConfig({
			docker,
			name: `dokploy-observability-redis-dashboard-${organizationId}`,
			content: JSON.stringify(REDIS_DASHBOARD),
			target: "/var/lib/grafana/dashboards/redis.json",
		}),
		createVersionedSecret({
			docker,
			name: `dokploy-observability-gateway-token-${organizationId}`,
			content: gatewayToken,
			target: "dokploy-observability-gateway-token",
		}),
		createVersionedSecret({
			docker,
			name: `dokploy-observability-alertmanager-token-${organizationId}`,
			content: alertmanagerToken,
			target: "dokploy-observability-alertmanager-token",
		}),
	]);

	await Promise.all([
		ensureService(docker, {
			Name: resources.prometheusService,
			Labels: { "dokploy.observability.managed": "true" },
			TaskTemplate: {
				ContainerSpec: {
					Image: OBSERVABILITY_IMAGES.prometheus,
					Args: [
						"--config.file=/etc/prometheus/prometheus.yml",
						"--storage.tsdb.path=/prometheus",
						`--storage.tsdb.retention.time=${OBSERVABILITY.retention}`,
						"--web.enable-lifecycle",
						"--web.enable-remote-write-receiver",
					],
					Configs: [prometheusConfig, prometheusRules],
					Secrets: [gatewaySecret],
					Mounts: [
						{
							Type: "volume",
							Source: resources.prometheusVolume,
							Target: "/prometheus",
						},
					],
				},
				Networks: [{ Target: networkId }],
				RestartPolicy: { Condition: "any" },
			},
			EndpointSpec: { Mode: "dnsrr", Ports: [] },
			Mode: { Replicated: { Replicas: 1 } },
			UpdateConfig: {
				Parallelism: 1,
				Order: "stop-first",
				FailureAction: "rollback",
			},
		}),
		ensureService(docker, {
			Name: resources.alertmanagerService,
			Labels: { "dokploy.observability.managed": "true" },
			TaskTemplate: {
				ContainerSpec: {
					Image: OBSERVABILITY_IMAGES.alertmanager,
					Args: [
						"--config.file=/etc/alertmanager/alertmanager.yml",
						"--storage.path=/alertmanager",
					],
					Configs: [alertmanagerConfig],
					Secrets: [alertmanagerSecret],
				},
				Networks: [{ Target: networkId }],
				RestartPolicy: { Condition: "any" },
			},
			EndpointSpec: { Mode: "dnsrr", Ports: [] },
			Mode: { Replicated: { Replicas: 1 } },
			UpdateConfig: {
				Parallelism: 1,
				Order: "stop-first",
				FailureAction: "rollback",
			},
		}),
		ensureService(docker, {
			Name: resources.grafanaService,
			Labels: { "dokploy.observability.managed": "true" },
			TaskTemplate: {
				ContainerSpec: {
					Image: OBSERVABILITY_IMAGES.grafana,
					Command: ["/bin/sh"],
					Args: [
						"-c",
						"export DOKPLOY_GATEWAY_TOKEN=$(cat /run/secrets/dokploy-observability-gateway-token); exec /run.sh",
					],
					Env: [
						`GF_SERVER_ROOT_URL=${publicUrl.replace(/\/$/, "")}/api/observability/grafana`,
						"GF_SERVER_SERVE_FROM_SUB_PATH=true",
						"GF_AUTH_PROXY_ENABLED=true",
						"GF_AUTH_PROXY_HEADER_NAME=X-Grafana-User",
						"GF_AUTH_PROXY_HEADER_PROPERTY=username",
						"GF_AUTH_PROXY_AUTO_SIGN_UP=true",
						"GF_AUTH_PROXY_SYNC_TTL=60",
						"GF_AUTH_DISABLE_LOGIN_FORM=true",
						"GF_USERS_AUTO_ASSIGN_ORG=true",
						"GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer",
						"GF_USERS_ALLOW_SIGN_UP=false",
						"GF_USERS_VIEWERS_CAN_EDIT=false",
						"GF_DATAPROXY_SEND_USER_HEADER=true",
						"GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION=true",
						"GF_ANALYTICS_REPORTING_ENABLED=false",
						"GF_ANALYTICS_CHECK_FOR_UPDATES=false",
					],
					Configs: [
						grafanaDatasources,
						grafanaProvider,
						postgresDashboard,
						redisDashboard,
					],
					Secrets: [gatewaySecret],
					Mounts: [
						{
							Type: "volume",
							Source: resources.grafanaVolume,
							Target: "/var/lib/grafana",
						},
					],
				},
				Networks: [{ Target: networkId }],
				RestartPolicy: { Condition: "any" },
			},
			EndpointSpec: { Mode: "dnsrr", Ports: [] },
			Mode: { Replicated: { Replicas: 1 } },
			UpdateConfig: {
				Parallelism: 1,
				Order: "stop-first",
				FailureAction: "rollback",
			},
		}),
	]);
	await cleanupUnusedManagedArtifacts(docker);
};

const agentServiceName = (organizationId: string) =>
	swarmServiceName(OBSERVABILITY.agentService, organizationId);

const agentWalVolumeName = (organizationId: string) =>
	`${OBSERVABILITY.agentWalVolume}-${safeName(organizationId).slice(0, 12)}`;

export const reconcileObservabilityAgent = async ({
	serverId,
	serverKey,
	organizationId,
	publicUrl,
	authToken,
}: {
	serverId?: string | null;
	serverKey: string;
	organizationId: string;
	publicUrl: string;
	authToken: string;
}) => {
	const docker = await getRemoteDocker(serverId);
	const networkId = await ensureNetwork(docker);
	const walVolume = agentWalVolumeName(organizationId);
	await ensureVolume(docker, walVolume);
	const agentContent = generateAgentConfig({
		publicUrl,
		serverKey,
		organizationId,
	});
	await validateObservabilityArtifacts({ agent: agentContent });
	const config = await createVersionedConfig({
		docker,
		name: `dokploy-observability-agent-${organizationId}`,
		content: agentContent,
		target: "/etc/prometheus/prometheus.yml",
	});
	const secret = await createVersionedSecret({
		docker,
		name: `dokploy-observability-agent-token-${organizationId}`,
		content: authToken,
		target: "dokploy-observability-agent-token",
	});

	await ensureService(docker, {
		Name: agentServiceName(organizationId),
		Labels: {
			"dokploy.observability.managed": "true",
			"dokploy.observability.kind": "agent",
			"dokploy.observability.organization_id": organizationId,
		},
		TaskTemplate: {
			ContainerSpec: {
				Image: OBSERVABILITY_IMAGES.prometheus,
				// Docker Swarm discovery needs permission to read the local
				// daemon socket. The socket itself remains mounted read-only.
				User: "0:0",
				Args: [
					"--config.file=/etc/prometheus/prometheus.yml",
					"--storage.agent.path=/prometheus",
					"--agent",
				],
				Configs: [config],
				Secrets: [secret],
				Mounts: [
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
						ReadOnly: true,
					},
					{
						Type: "volume",
						Source: walVolume,
						Target: "/prometheus",
					},
				],
			},
			Networks: [{ Target: networkId }],
			RestartPolicy: { Condition: "any" },
		},
		EndpointSpec: { Mode: "dnsrr", Ports: [] },
		Mode: { Replicated: { Replicas: 1 } },
		UpdateConfig: {
			Parallelism: 1,
			Order: "stop-first",
			FailureAction: "rollback",
		},
	});
	await cleanupUnusedManagedArtifacts(docker);
};

const exporterServiceName = (databaseType: DatabaseKind, serviceId: string) =>
	swarmServiceName(`dokploy-${databaseType}-exporter`, serviceId);

const getDatabaseNetworks = async (
	docker: DockerClient,
	appName: string,
	observabilityNetworkId: string,
) => {
	const databaseService = await docker.getService(appName).inspect();
	const attached =
		(databaseService.Spec.TaskTemplate.Networks as
			| NetworkAttachmentConfig[]
			| undefined) ?? [];
	const targets = new Set<string>(
		attached.flatMap((network) => (network.Target ? [network.Target] : [])),
	);
	targets.add(observabilityNetworkId);
	return [...targets].map((Target) => ({ Target }));
};

export const reconcileDatabaseExporter = async (
	database: DatabaseDeployment,
) => {
	const serverId =
		database.serverId === "local" ? undefined : database.serverId;
	const docker = await getRemoteDocker(serverId);
	const networkId = await ensureNetwork(docker);
	const networks = await getDatabaseNetworks(
		docker,
		database.appName,
		networkId,
	);
	const passwordFile =
		database.databaseType === "postgres"
			? "dokploy-postgres-password"
			: "dokploy-redis-password";
	const password = await createVersionedSecret({
		docker,
		name: `dokploy-${database.databaseType}-exporter-password-${database.serviceId}`,
		// redis_exporter's password-file contract is an address-to-password JSON
		// map. PostgreSQL accepts the secret as a plain password file.
		content:
			database.databaseType === "redis"
				? JSON.stringify({
						[`redis://${database.appName}:6379`]: database.databasePassword,
					})
				: database.databasePassword,
		target: passwordFile,
	});
	const port = database.databaseType === "postgres" ? 9187 : 9121;
	const image =
		database.databaseType === "postgres"
			? OBSERVABILITY_IMAGES.postgresExporter
			: OBSERVABILITY_IMAGES.redisExporter;
	const env =
		database.databaseType === "postgres"
			? [
					`DATA_SOURCE_URI=${database.appName}:5432/${database.databaseName ?? "postgres"}?sslmode=disable`,
					`DATA_SOURCE_USER=${database.databaseUser ?? "postgres"}`,
					`DATA_SOURCE_PASS_FILE=/run/secrets/${passwordFile}`,
				]
			: [
					`REDIS_ADDR=redis://${database.appName}:6379`,
					`REDIS_PASSWORD_FILE=/run/secrets/${passwordFile}`,
				];

	await ensureService(docker, {
		Name: exporterServiceName(database.databaseType, database.serviceId),
		Labels: {
			"dokploy.observability.managed": "true",
			"dokploy.observability.kind": "exporter",
			"dokploy.observability.exporter": "true",
			"dokploy.observability.port": String(port),
			"dokploy.observability.organization_id": database.organizationId,
			"dokploy.observability.server_id": database.serverId,
			"dokploy.observability.project_id": database.projectId,
			"dokploy.observability.environment_id": database.environmentId,
			"dokploy.observability.database_type": database.databaseType,
			"dokploy.observability.service_id": database.serviceId,
		},
		TaskTemplate: {
			ContainerSpec: {
				Image: image,
				Env: env,
				Secrets: [password],
			},
			Networks: networks,
			RestartPolicy: { Condition: "any" },
		},
		EndpointSpec: { Mode: "dnsrr", Ports: [] },
		Mode: { Replicated: { Replicas: 1 } },
		UpdateConfig: {
			Parallelism: 1,
			Order: "stop-first",
			FailureAction: "rollback",
		},
	});
	await cleanupUnusedManagedArtifacts(docker);
};

export const removeDatabaseExporter = async ({
	databaseType,
	serviceId,
	serverId,
}: {
	databaseType: DatabaseKind;
	serviceId: string;
	serverId?: string | null;
}) => {
	const docker = await getRemoteDocker(serverId);
	await removeServiceIfPresent(
		docker,
		exporterServiceName(databaseType, serviceId),
	);
	await cleanupUnusedManagedArtifacts(docker);
};

export const cleanupUnexpectedExporters = async ({
	serverId,
	expectedServiceIds,
}: {
	serverId?: string | null;
	expectedServiceIds: Set<string>;
}) => {
	const docker = await getRemoteDocker(serverId);
	const services = await docker.listServices({
		filters: {
			label: [
				"dokploy.observability.managed=true",
				"dokploy.observability.kind=exporter",
			],
		},
	});
	for (const service of services) {
		const labels = service.Spec?.Labels ?? {};
		const serviceId = labels["dokploy.observability.service_id"];
		const name = service.Spec?.Name;
		if (serviceId && name && !expectedServiceIds.has(serviceId)) {
			await removeServiceIfPresent(docker, name);
		}
	}
	await cleanupUnusedManagedArtifacts(docker);
};

export const disableObservabilityComponents = async ({
	organizationId,
	serverIds,
}: {
	organizationId: string;
	serverIds: Array<string | null>;
}) => {
	const centralDocker = await getRemoteDocker();
	const resources = getOrganizationObservabilityResources(organizationId);
	await Promise.all([
		removeServiceIfPresent(centralDocker, resources.prometheusService),
		removeServiceIfPresent(centralDocker, resources.alertmanagerService),
		removeServiceIfPresent(centralDocker, resources.grafanaService),
	]);
	for (const serverId of serverIds) {
		const docker = await getRemoteDocker(serverId);
		await removeServiceIfPresent(docker, agentServiceName(organizationId));
		const services = await docker.listServices({
			filters: {
				label: [
					"dokploy.observability.managed=true",
					`dokploy.observability.organization_id=${organizationId}`,
				],
			},
		});
		for (const service of services) {
			if (
				service.Spec?.Labels?.["dokploy.observability.kind"] === "exporter" &&
				service.Spec.Name
			) {
				await removeServiceIfPresent(docker, service.Spec.Name);
			}
		}
		await cleanupUnusedManagedArtifacts(docker);
	}
	await cleanupUnusedManagedArtifacts(centralDocker);
	// Persistent Prometheus and Grafana volumes are intentionally retained.
};

export const getExporterServiceName = exporterServiceName;

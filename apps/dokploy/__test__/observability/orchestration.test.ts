import { beforeEach, describe, expect, it, vi } from "vitest";

const remoteDocker = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: remoteDocker,
}));

import { OBSERVABILITY } from "@dokploy/server/observability/constants";
import {
	cleanupUnexpectedExporters,
	getExporterServiceName,
	reconcileDatabaseExporter,
	removeDatabaseExporter,
} from "@dokploy/server/observability/orchestration";

type StoredService = {
	ID: string;
	Version: { Index: number };
	Spec: Record<string, any>;
};

const notFound = () =>
	Object.assign(new Error("service not found"), { statusCode: 404 });

const createFakeDocker = () => {
	const services = new Map<string, StoredService>();
	const secrets = new Map<
		string,
		{ ID: string; Spec: { Name: string; Data?: string } }
	>();
	const networks = new Map<string, { Id: string; Name: string }>();
	let serviceSequence = 0;
	let secretSequence = 0;

	services.set("database-app", {
		ID: "database-service",
		Version: { Index: 1 },
		Spec: {
			Name: "database-app",
			TaskTemplate: {
				Networks: [{ Target: "custom-database-network" }],
			},
		},
	});

	const docker = {
		services,
		secrets,
		networks,
		listNetworks: vi.fn(async () => [...networks.values()]),
		createNetwork: vi.fn(async ({ Name }: { Name: string }) => {
			const network = { Id: `network-${networks.size + 1}`, Name };
			networks.set(Name, network);
			return { id: network.Id };
		}),
		listSecrets: vi.fn(
			async ({
				filters,
			}: {
				filters: { name?: string[]; label?: string[] };
			}) =>
				filters.name
					? [...secrets.values()].filter((secret) =>
							filters.name?.includes(secret.Spec.Name),
						)
					: [...secrets.values()],
		),
		listConfigs: vi.fn(async () => []),
		createSecret: vi.fn(
			async ({ Name, Data }: { Name: string; Data: string }) => {
				secretSequence += 1;
				const stored = {
					ID: `secret-${secretSequence}`,
					Spec: { Name, Data },
				};
				secrets.set(Name, stored);
				// Dockerode resolves createSecret() to a Secret handle rather
				// than the raw API response.
				return {
					id: stored.ID,
					inspect: async () => stored,
				};
			},
		),
		getSecret: vi.fn((id: string) => ({
			inspect: async () =>
				[...secrets.values()].find((secret) => secret.ID === id),
			remove: async () => {
				const entry = [...secrets.entries()].find(
					([, secret]) => secret.ID === id,
				);
				if (entry) secrets.delete(entry[0]);
			},
		})),
		getConfig: vi.fn(() => ({
			remove: async () => undefined,
		})),
		listServices: vi.fn(async () => [...services.values()]),
		createService: vi.fn(async (spec: Record<string, any>) => {
			serviceSequence += 1;
			services.set(spec.Name, {
				ID: `service-${serviceSequence}`,
				Version: { Index: 1 },
				Spec: spec,
			});
		}),
		getService: vi.fn((name: string) => ({
			inspect: async () => {
				const service = services.get(name);
				if (!service) throw notFound();
				return service;
			},
			update: async (spec: Record<string, any>) => {
				const current = services.get(name);
				if (!current) throw notFound();
				services.set(name, {
					...current,
					Version: { Index: current.Version.Index + 1 },
					Spec: spec,
				});
			},
			remove: async () => {
				if (!services.delete(name)) throw notFound();
			},
		})),
	};
	return docker;
};

const redisDeployment = (password = "redis-secret") => ({
	serviceId: "redis-1",
	name: "Redis",
	appName: "database-app",
	databaseType: "redis" as const,
	organizationId: "org-1",
	serverId: "local",
	projectId: "project-1",
	environmentId: "environment-1",
	databasePassword: password,
	monitoringEnabled: true,
	applicationStatus: "done" as const,
});

describe("database exporter reconciliation", () => {
	let docker: ReturnType<typeof createFakeDocker>;

	beforeEach(() => {
		docker = createFakeDocker();
		remoteDocker.mockReset();
		remoteDocker.mockResolvedValue(docker);
	});

	it("is idempotent and attaches custom plus observability networks", async () => {
		await reconcileDatabaseExporter(redisDeployment());
		await reconcileDatabaseExporter(redisDeployment());

		expect(docker.createNetwork).toHaveBeenCalledTimes(1);
		expect(docker.createSecret).toHaveBeenCalledTimes(1);
		expect(docker.createService).toHaveBeenCalledTimes(1);

		const exporter = docker.services.get(
			getExporterServiceName("redis", "redis-1"),
		);
		const attachedNetworks =
			exporter?.Spec.TaskTemplate.Networks.map(
				(network: { Target: string }) => network.Target,
			) ?? [];
		expect(attachedNetworks).toEqual(
			expect.arrayContaining([
				"custom-database-network",
				docker.networks.get(OBSERVABILITY.network)?.Id,
			]),
		);
		expect(exporter?.Spec.EndpointSpec.Ports).toEqual([]);
	});

	it("rotates an immutable password secret without exposing it in the service spec", async () => {
		await reconcileDatabaseExporter(redisDeployment("first-password"));
		await reconcileDatabaseExporter(redisDeployment("second-password"));

		expect(docker.createSecret).toHaveBeenCalledTimes(2);
		const exporter = docker.services.get(
			getExporterServiceName("redis", "redis-1"),
		);
		expect(JSON.stringify(exporter?.Spec)).not.toContain("first-password");
		expect(JSON.stringify(exporter?.Spec)).not.toContain("second-password");
		expect(exporter?.Spec.TaskTemplate.ContainerSpec.Env).toContain(
			"REDIS_PASSWORD_FILE=/run/secrets/dokploy-redis-password",
		);
		expect(exporter?.Spec.TaskTemplate.ContainerSpec.Secrets[0].File.Mode).toBe(
			0o444,
		);

		const secretPayloads = [...docker.secrets.values()].map((secret) =>
			Buffer.from(secret.Spec.Data ?? "", "base64").toString("utf8"),
		);
		expect(secretPayloads).not.toContain(
			JSON.stringify({
				"redis://database-app:6379": "first-password",
			}),
		);
		expect(secretPayloads).toContain(
			JSON.stringify({
				"redis://database-app:6379": "second-password",
			}),
		);
	});

	it("removes an opted-out exporter and cleans a deleted database exporter", async () => {
		await reconcileDatabaseExporter(redisDeployment());
		const serviceName = getExporterServiceName("redis", "redis-1");
		expect(docker.services.has(serviceName)).toBe(true);

		await removeDatabaseExporter({
			databaseType: "redis",
			serviceId: "redis-1",
		});
		expect(docker.services.has(serviceName)).toBe(false);

		await reconcileDatabaseExporter(redisDeployment());
		await cleanupUnexpectedExporters({
			expectedServiceIds: new Set(),
		});
		expect(docker.services.has(serviceName)).toBe(false);
	});

	it("does not hide Docker daemon errors while inspecting a service", async () => {
		docker.getService.mockImplementationOnce(() => ({
			inspect: async () => {
				throw Object.assign(new Error("daemon unavailable"), {
					statusCode: 503,
				});
			},
			update: async () => undefined,
			remove: async () => undefined,
		}));

		await expect(reconcileDatabaseExporter(redisDeployment())).rejects.toThrow(
			"daemon unavailable",
		);
		expect(docker.createService).not.toHaveBeenCalled();
	});

	it("keeps versioned Swarm resource names within Docker's 64-character limit", async () => {
		await reconcileDatabaseExporter({
			...redisDeployment(),
			serviceId: "jlgD5Mpah6VfNEdoNHwJQ",
		});

		const secretName = docker.createSecret.mock.calls[0]?.[0]?.Name;
		expect(secretName).toBeDefined();
		expect(secretName).toHaveLength(64);
	});

	it("sanitizes URL-safe ids used in exporter service names as DNS labels", () => {
		const serviceName = getExporterServiceName(
			"redis",
			"_jlgD5Mpah6VfNEdoNHwJQ_",
		);

		expect(serviceName).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
		expect(serviceName.length).toBeLessThanOrEqual(63);
	});
});

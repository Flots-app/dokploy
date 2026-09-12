import { composePreviewSettingsSchema } from "@dokploy/server/db/validations/compose-preview";
import type { Domain } from "@dokploy/server/services/domain";
import {
	isolatePreviewCompose,
	previewAppName,
	previewHost,
} from "@dokploy/server/utils/docker/compose-preview";
import {
	assignPreviewImages,
	createPreviewStack,
} from "@dokploy/server/utils/docker/compose-preview-stack";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { describe, expect, it } from "vitest";

const settings = composePreviewSettingsSchema.parse({
	serverId: "worker",
	registryId: "registry",
	baseBranch: "main",
	composePath: "compose.yml",
	domain: "preview.example.com",
});
const source: ComposeSpecification = {
	name: "staging",
	services: {
		api: {
			build: ".",
			image: "staging-api:latest",
			container_name: "staging",
			ports: ["8080:80"],
			networks: ["production"],
			labels: { "traefik.http.routers.prod.rule": "Host(`prod.example.com`)" },
			deploy: {
				replicas: 8,
				placement: { constraints: ["node.role==manager"] },
			},
		},
		scheduler: { image: "staging-api:latest" },
		postgres: {
			image: "postgres:17",
			volumes: ["database:/var/lib/postgresql/data"],
		},
	},
	volumes: { database: { name: "production-database" } },
	networks: { production: { external: true } },
};
const registry = {
	registryUrl: "ghcr.io",
	imagePrefix: "Example",
	username: "builder",
};

describe("Compose PR isolation", () => {
	it("keeps the source unchanged and separates stable identities between PRs and apps", () => {
		const before = structuredClone(source);
		const one = isolatePreviewCompose(
			source,
			previewAppName("app", 1),
			settings,
		);
		const two = isolatePreviewCompose(
			source,
			previewAppName("app", 2),
			settings,
		);
		expect(source).toEqual(before);
		expect(one.name).not.toEqual(two.name);
		expect(previewAppName("other-app", 1)).not.toEqual(one.name);
		expect(one.services?.api?.ports).toBeUndefined();
		expect(one.services?.api?.container_name).toBeUndefined();
		expect(one.services?.api?.labels).toEqual(["com.dokploy.preview=true"]);
		expect(one.services?.api?.networks).toEqual(["default"]);
		expect(one.services?.api?.deploy?.resources?.limits).toEqual({
			cpus: "2",
			memory: "1024M",
			pids: 512,
		});
		expect(one.volumes?.database?.name).toBeUndefined();
		expect(one.services?.scheduler?.image).toEqual(one.services?.api?.image);
	});
	it("gives distinct hosts to API and WebSocket routes on the same service", () => {
		expect(
			previewHost("preview-one", "backend", settings.domain, "api-route"),
		).not.toEqual(
			previewHost("preview-one", "backend", settings.domain, "collab-route"),
		);
	});
	it("avoids service hostname collisions after slug normalization", () => {
		const app = previewAppName("app", 2147483647);
		expect(previewHost(app, "api_service", settings.domain)).not.toEqual(
			previewHost(app, "api-service", settings.domain),
		);
		expect(
			previewHost(app, "a".repeat(100), settings.domain).split(".")[0]?.length,
		).toBeLessThanOrEqual(63);
	});
	it.each([
		{ privileged: true },
		{ network_mode: "host" },
		{ pid: "host" },
		{ cap_add: ["SYS_ADMIN"] },
		{ volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
		{ volumes: [{ type: "bind", source: "./data", target: "/data" }] },
		{ volumes: ["missing:/data"] },
		{ volumes: ["/data"] },
		{ env_file: "../staging.env" },
		{ build: { context: "../" } },
		{ build: { context: ".", dockerfile: "../secret" } },
		{ build: { context: ".", additional_contexts: { host: "/" } } },
		{ build: { context: ".", ssh: ["default"] } },
		{ gpus: "all" },
		{ sysctls: { "net.ipv4.ip_forward": "1" } },
	])("rejects a host escape or shared resource: %j", (service) => {
		expect(() =>
			isolatePreviewCompose(
				{ services: { api: service } } as ComposeSpecification,
				"preview-test",
				settings,
			),
		).toThrow();
	});
	it.each([
		{ external: true },
		{ driver_opts: { device: "/", type: "none", o: "bind" } },
		{ driver: "shared-plugin" },
	])("rejects shared volumes: %j", (definition) => {
		expect(() =>
			isolatePreviewCompose(
				{ ...source, volumes: { database: definition } },
				"preview-test",
				settings,
			),
		).toThrow();
	});
	it("accepts empty named volume definitions", () => {
		expect(() =>
			isolatePreviewCompose(
				{ ...source, volumes: { database: {} } },
				"preview-test",
				settings,
			),
		).not.toThrow();
	});
	it.each([
		"/compose.yml",
		"../compose.yml",
		"nested/../compose.yml",
		"~/.ssh/config",
		"a\\b.yml",
		"${FILE}",
		"a\nfile",
	])("rejects an unsafe compose path %s", (composePath) => {
		expect(
			composePreviewSettingsSchema.safeParse({ ...settings, composePath })
				.success,
		).toBe(false);
	});
});

describe("Swarm preview manifest", () => {
	it("uses per-deployment registry images, pins every service and labels owned resources", () => {
		const isolated = isolatePreviewCompose(source, "preview-one", settings);
		const images = assignPreviewImages(
			isolated,
			"preview-one",
			"commit-one",
			registry,
		);
		expect(images.services?.api?.image).toMatch(
			/^ghcr.io\/example\/preview-one-.+:commit-one$/,
		);
		expect(images.services?.scheduler?.image).toEqual(
			images.services?.api?.image,
		);
		const stack = createPreviewStack(images, {
			appName: "preview-one",
			previewId: "pr-id",
			nodeId: "worker-node",
			generation: "generation",
			domains: [],
		});
		expect(stack.name).toBeUndefined();
		expect(stack.version).toBe("3.8");
		for (const service of Object.values(stack.services || {})) {
			expect(service.build).toBeUndefined();
			expect(service.deploy?.placement?.constraints).toEqual([
				"node.id==worker-node",
			]);
			expect(service.deploy?.replicas).toBe(0);
			expect(service.deploy?.resources?.limits?.pids).toBeUndefined();
			expect(typeof service.deploy?.resources?.limits?.cpus).toBe("string");
			expect(service.deploy?.labels).toEqual({
				"com.dokploy.compose-preview": "pr-id",
				"traefik.enable": "false",
			});
			expect(service.labels).toContain("com.dokploy.preview-id=pr-id");
		}
		expect(stack.networks?.default?.driver).toBe("overlay");
		expect(stack.volumes?.database?.labels).toEqual({
			"com.dokploy.preview-id": "pr-id",
		});
	});
	it("rejects a route to a missing service", () => {
		expect(() =>
			createPreviewStack(source, {
				appName: "preview-one",
				previewId: "pr-id",
				nodeId: "worker-node",
				generation: "generation",
				domains: [{ serviceName: "missing" } as Domain],
			}),
		).toThrow("missing Compose service");
	});
	it("deduplicates shared Traefik labels for several routes on one service", () => {
		const stack = createPreviewStack(
			isolatePreviewCompose(source, "preview-one", settings),
			{
				appName: "preview-one",
				previewId: "pr-id",
				nodeId: "worker-node",
				generation: "one",
				domains: [8080, 1234].map(
					(port) =>
						({
							serviceName: "api",
							port,
							host: `api-${port}.example.com`,
							uniqueConfigKey: port,
							path: "/",
						}) as Domain,
				),
			},
		);
		const labels = stack.services?.api?.labels as string[];
		expect(labels.length).toBe(new Set(labels).size);
		expect(labels).toContain("traefik.enable=true");
	});
	it("versions immutable configs and secrets while preserving logical references", () => {
		const spec = {
			...source,
			configs: { config: { file: "config.json" } },
			secrets: { secret: { file: "secret.txt" } },
		};
		const options = {
			appName: "preview-one",
			previewId: "pr-id",
			nodeId: "worker-node",
			domains: [],
		};
		const one = createPreviewStack(spec, { ...options, generation: "one" });
		const two = createPreviewStack(spec, { ...options, generation: "two" });
		expect(one.configs?.config?.name).not.toEqual(two.configs?.config?.name);
		expect(one.secrets?.secret?.name).not.toEqual(two.secrets?.secret?.name);
		expect(one.configs?.config?.labels).toEqual({
			"com.dokploy.preview-id": "pr-id",
		});
	});
});

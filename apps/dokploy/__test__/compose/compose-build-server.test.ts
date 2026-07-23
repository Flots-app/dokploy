import {
	assertComposeBuildServerSelection,
	assertComposeBuildServerSupported,
	type ComposeBuildServerDomain,
	type ComposeRuntimeReleaseState,
	createComposeReleaseTraefikRouterConfig,
	createComposeReleaseTraefikServiceConfig,
	createRuntimeComposeManifest,
	getAcquireComposeActivationLockCommand,
	getComposeBuildPushCommand,
	getComposeConfigCommand,
	getComposeRegistryLoginCommand,
	getComposeReleaseProjectName,
	getComposeReleaseServiceAlias,
	getRuntimeDeployCommand,
	getRuntimePullCommands,
	getWaitTraefikRoutersCommand,
	validateComposeBuildServerSpecification,
} from "@dokploy/server/utils/builders/compose-build-server";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { describe, expect, it } from "vitest";

const deploymentId = "deployment-123";
const registry = {
	registryUrl: "registry.example.com",
	imagePrefix: "flots",
	username: "builder",
};
const compose = {
	appName: "flots-staging",
	composePath: "docker-compose.yml",
	composeType: "docker-compose" as const,
	sourceType: "github",
	command: "",
	isolatedDeployment: false,
};

const domains: ComposeBuildServerDomain[] = [
	{
		host: "api.example.com",
		https: true,
		port: 80,
		customEntrypoint: null,
		path: "/",
		serviceName: "backend-staging",
		uniqueConfigKey: 1,
		certificateType: "letsencrypt",
		customCertResolver: null,
		internalPath: "/",
		stripPath: false,
		middlewares: [],
	},
	{
		host: "app.example.com",
		https: true,
		port: 80,
		customEntrypoint: null,
		path: "/",
		serviceName: "frontend-staging",
		uniqueConfigKey: 2,
		certificateType: "letsencrypt",
		customCertResolver: null,
		internalPath: "/",
		stripPath: false,
		middlewares: [],
	},
	{
		host: "admin.example.com",
		https: true,
		port: 80,
		customEntrypoint: null,
		path: "/",
		serviceName: "back-office-staging",
		uniqueConfigKey: 3,
		certificateType: "letsencrypt",
		customCertResolver: null,
		internalPath: "/",
		stripPath: false,
		middlewares: [],
	},
];

const zeroDowntimeExtension = (
	healthchecks: Record<string, { path: string }> = {
		"backend-staging": { path: "/health" },
		"frontend-staging": { path: "/" },
		"back-office-staging": { path: "/" },
	},
) => ({
	"x-dokploy": {
		"zero-downtime": {
			"overlap-safe": true,
			healthchecks,
			"shared-volumes": [],
			"readiness-timeout-seconds": 120,
			"stabilization-seconds": 30,
			"drain-seconds": 30,
		},
	},
});

type ComposeService = NonNullable<ComposeSpecification["services"]>[string];

const routedService = (service: ComposeService) => ({
	...service,
	healthcheck: { test: ["CMD", "true"] },
	stop_grace_period: "30s",
});

const flotsCompose = (): ComposeSpecification => ({
	...zeroDowntimeExtension(),
	services: {
		"backend-staging": routedService({
			build: { context: ".", dockerfile: "backend/Dockerfile" },
			image: `registry.example.com/flots/backend:${deploymentId}`,
		}),
		"scheduler-staging": {
			image: `registry.example.com/flots/backend:${deploymentId}`,
			command: ["php", "artisan", "schedule:work"],
		},
		"frontend-staging": routedService({
			build: { context: "frontend" },
			image: `registry.example.com/flots/frontend:${deploymentId}`,
		}),
		"back-office-staging": routedService({
			build: { context: "back-office" },
			image: `registry.example.com/flots/back-office:${deploymentId}`,
		}),
	},
});

const apiDomain = (): ComposeBuildServerDomain => ({
	...domains[0]!,
	serviceName: "api",
});

const apiCompose = (
	service: ComposeService,
	extra: Partial<ComposeSpecification> = {},
): ComposeSpecification => ({
	...zeroDowntimeExtension({ api: { path: "/health" } }),
	...extra,
	services: { api: routedService(service) },
});

describe("Compose Build Server validation", () => {
	const validSelection = {
		organizationId: "org-1",
		accessibleServerIds: new Set(["build-1"]),
		server: {
			serverId: "build-1",
			organizationId: "org-1",
			serverStatus: "active" as const,
			serverType: "build" as const,
			sshKeyId: "key-1",
		},
		registry: { organizationId: "org-1" },
	};

	it("accepts an accessible active Build Server and same-org registry", () => {
		expect(() =>
			assertComposeBuildServerSelection(validSelection),
		).not.toThrow();
	});

	it.each([
		[
			"inaccessible server",
			{ ...validSelection, accessibleServerIds: new Set<string>() },
			"not authorized",
		],
		[
			"inactive server",
			{
				...validSelection,
				server: { ...validSelection.server, serverStatus: "inactive" as const },
			},
			"active Build Server",
		],
		[
			"deploy server",
			{
				...validSelection,
				server: { ...validSelection.server, serverType: "deploy" as const },
			},
			"active Build Server",
		],
		[
			"cross-org registry",
			{ ...validSelection, registry: { organizationId: "org-2" } },
			"same organization",
		],
	] as const)("rejects %s", (_name, selection, message) => {
		expect(() => assertComposeBuildServerSelection(selection)).toThrow(message);
	});

	it("accepts the corrected Flots contract and shared backend image", () => {
		const result = validateComposeBuildServerSpecification(
			flotsCompose(),
			registry,
			deploymentId,
			[],
			domains,
		);
		expect(result.builtServices).toEqual([
			"backend-staging",
			"frontend-staging",
			"back-office-staging",
		]);
		expect(result.builtImages).toHaveLength(3);
	});

	it("requires at least one buildable service", () => {
		expect(() =>
			validateComposeBuildServerSpecification(
				apiCompose({ image: "busybox" }),
				registry,
				deploymentId,
				[],
				[apiDomain()],
			),
		).toThrow("at least one service with build:");
	});

	it.each([
		["missing image", undefined, "must define image:"],
		["latest tag", "registry.example.com/flots/api:latest", "immutable tag"],
		[
			"wrong registry",
			`other.example.com/flots/api:${deploymentId}`,
			"outside",
		],
	])("rejects %s", (_name, image, message) => {
		expect(() =>
			validateComposeBuildServerSpecification(
				apiCompose({ build: ".", image }),
				registry,
				deploymentId,
				[],
				[apiDomain()],
			),
		).toThrow(message);
	});

	it("rejects two builds targeting the same image", () => {
		const image = `registry.example.com/flots/api:${deploymentId}`;
		expect(() =>
			validateComposeBuildServerSpecification(
				{
					...apiCompose({ build: "./api", image }),
					services: {
						api: routedService({ build: "./api", image }),
						worker: { build: "./worker", image },
					},
				},
				registry,
				deploymentId,
				[],
				[apiDomain()],
			),
		).toThrow("target the same image");
	});

	it.each([
		[
			"bind mount",
			apiCompose({
				build: ".",
				image: `registry.example.com/flots/api:${deploymentId}`,
				volumes: [{ type: "bind", source: "/tmp/data", target: "/data" }],
			}),
			"bind mount",
		],
		[
			"configs.file",
			apiCompose(
				{
					build: ".",
					image: `registry.example.com/flots/api:${deploymentId}`,
				},
				{
					configs: { local: { file: "/tmp/config" } },
				},
			),
			"configs.file",
		],
		[
			"secrets.file",
			apiCompose(
				{
					build: ".",
					image: `registry.example.com/flots/api:${deploymentId}`,
				},
				{
					secrets: { local: { file: "/tmp/secret" } },
				},
			),
			"secrets.file",
		],
	] as const)("rejects a runtime %s", (_name, specification, message) => {
		expect(() =>
			validateComposeBuildServerSpecification(
				specification as ComposeSpecification,
				registry,
				deploymentId,
				[],
				[apiDomain()],
			),
		).toThrow(message);
	});

	it("rejects Dokploy file mounts", () => {
		expect(() =>
			validateComposeBuildServerSpecification(
				flotsCompose(),
				registry,
				deploymentId,
				[{ type: "file", filePath: "/etc/flots/app.env" }],
				domains,
			),
		).toThrow("Dokploy file mount");
	});

	it.each([
		["host ports", { ports: ["8080:80"] }, "publishes host ports"],
		["container_name", { container_name: "api" }, "container_name"],
		["network_mode", { network_mode: "host" }, "network_mode"],
		["Traefik labels", { labels: ["traefik.enable=true"] }, "Traefik labels"],
	])("rejects zero-downtime %s", (_name, override, message) => {
		expect(() =>
			validateComposeBuildServerSpecification(
				apiCompose({
					build: ".",
					image: `registry.example.com/flots/api:${deploymentId}`,
					...override,
				}),
				registry,
				deploymentId,
				[],
				[apiDomain()],
			),
		).toThrow(message);
	});

	it("requires the explicit overlap-safe and healthcheck contract", () => {
		const specification = flotsCompose();
		delete specification["x-dokploy"];
		expect(() =>
			validateComposeBuildServerSpecification(
				specification,
				registry,
				deploymentId,
				[],
				domains,
			),
		).toThrow("x-dokploy.zero-downtime");

		const noHealthcheck = flotsCompose();
		delete noHealthcheck.services?.["backend-staging"]?.healthcheck;
		expect(() =>
			validateComposeBuildServerSpecification(
				noHealthcheck,
				registry,
				deploymentId,
				[],
				domains,
			),
		).toThrow("enabled Compose healthcheck");
	});

	it("only allows explicitly safe external shared volumes", () => {
		const specification = apiCompose(
			{
				build: ".",
				image: `registry.example.com/flots/api:${deploymentId}`,
				volumes: [{ type: "volume", source: "uploads", target: "/uploads" }],
			},
			{ volumes: { uploads: { external: true } } },
		);
		expect(() =>
			validateComposeBuildServerSpecification(
				specification,
				registry,
				deploymentId,
				[],
				[apiDomain()],
			),
		).toThrow("shared-volumes");
	});

	it.each([
		[{ ...compose, composeType: "stack" as const }, "Docker Stack"],
		[{ ...compose, sourceType: "raw" }, "raw Compose"],
		[{ ...compose, command: "compose up" }, "custom Compose commands"],
	])("rejects unsupported V1 configuration", (settings, message) => {
		expect(() => assertComposeBuildServerSupported(settings)).toThrow(message);
	});
});

describe("Compose Build Server commands", () => {
	it("preserves HOME and never embeds a registry password", () => {
		const command = getComposeRegistryLoginCommand(registry);
		expect(command).toContain('HOME="$HOME"');
		expect(command).toContain("--password-stdin");
		expect(command).not.toContain("super-secret");
	});

	it("resolves JSON and builds with push only in the build command", () => {
		expect(getComposeConfigCommand(compose, deploymentId)).toContain(
			"config --format json",
		);
		const command = getComposeBuildPushCommand(compose, deploymentId);
		expect(command).toContain("build --push");
		expect(command).toContain(`DOKPLOY_DEPLOYMENT_ID=${deploymentId}`);
		expect(command).not.toContain(" up ");
	});

	it("removes every build section from the runtime manifest", () => {
		const resolved = flotsCompose();
		resolved.networks = {
			default: {
				name: `${compose.appName}_default`,
			},
		};
		const runtime = createRuntimeComposeManifest(resolved, {
			appName: compose.appName,
			composeId: "compose-1",
			deploymentId,
		});
		for (const service of Object.values(runtime.services || {})) {
			expect(service).not.toHaveProperty("build");
		}
		expect(runtime.services?.["scheduler-staging"]?.image).toBe(
			`registry.example.com/flots/backend:${deploymentId}`,
		);
		expect(runtime).not.toHaveProperty("x-dokploy");
		expect(runtime.services?.["backend-staging"]?.labels).toMatchObject({
			"com.dokploy.compose-id": "compose-1",
			"com.dokploy.deployment-id": deploymentId,
			"com.dokploy.runtime-project": getComposeReleaseProjectName(
				compose.appName,
				deploymentId,
			),
		});
		expect(runtime.networks?.default).not.toHaveProperty("name");
		const runtimeNetworks = runtime.services?.["backend-staging"]?.networks;
		expect(Array.isArray(runtimeNetworks)).toBe(false);
		expect(
			!Array.isArray(runtimeNetworks)
				? runtimeNetworks?.["dokploy-network"]?.aliases
				: undefined,
		).toContain(
			getComposeReleaseServiceAlias(
				compose.appName,
				deploymentId,
				"backend-staging",
			),
		);
	});

	it("pulls immutable images before an activation that cannot build", () => {
		const projectName = getComposeReleaseProjectName(
			compose.appName,
			deploymentId,
		);
		const pulls = getRuntimePullCommands(projectName, "/tmp/runtime.json", [
			"backend-staging",
		]);
		expect(pulls.every((command) => !command.includes(" up "))).toBe(true);
		expect(pulls.every((command) => !command.includes("--build"))).toBe(true);
		expect(pulls[0]).toContain("pull --policy always backend-staging");
		expect(pulls[1]).toContain("pull --policy missing");
		const deploy = getRuntimeDeployCommand(
			projectName,
			"/tmp/runtime.json",
			120,
		);
		expect(deploy).toContain(
			"up -d --no-build --pull never --wait --wait-timeout 120",
		);
		expect(deploy).not.toContain("--build");
		expect(deploy).not.toContain(`-p ${compose.appName} -f`);
	});

	it("creates bounded release projects and an atomic Traefik failover", () => {
		const projectName = getComposeReleaseProjectName(
			"x".repeat(63),
			deploymentId,
		);
		expect(projectName).toHaveLength(63);
		const validation = validateComposeBuildServerSpecification(
			flotsCompose(),
			registry,
			deploymentId,
			[],
			domains,
		);
		const release = createComposeReleaseTraefikServiceConfig({
			appName: compose.appName,
			deploymentId,
			domains,
			settings: validation.zeroDowntime,
		});
		expect(
			release.config.http?.routers?.[`${release.domainServices["1"]}-probe`]
				?.rule,
		).toContain(".dokploy.invalid`)");
		expect(
			release.config.http?.routers?.[`${release.domainServices["1"]}-probe`]
				?.service,
		).toBe(release.domainServices["1"]);
		expect(
			Object.values(release.config.http?.routers ?? {}).some((router) =>
				router.rule.includes("backend.flots.test"),
			),
		).toBe(false);
		const candidate: ComposeRuntimeReleaseState = {
			version: 1,
			composeId: "compose-1",
			deploymentId,
			projectName,
			manifestPath: "/runtime.json",
			serviceConfigPath: "/service.yml",
			routerConfigPath: "/router.yml",
			domainServices: release.domainServices,
			activatedAt: new Date(0).toISOString(),
		};
		const previous: ComposeRuntimeReleaseState = {
			...candidate,
			deploymentId: "previous",
			domainServices: Object.fromEntries(
				Object.keys(candidate.domainServices).map((key) => [
					key,
					`previous-${key}`,
				]),
			),
		};
		const router = createComposeReleaseTraefikRouterConfig({
			appName: compose.appName,
			domains,
			candidate,
			previous,
		});
		expect(
			router.http?.services?.[`${compose.appName}-1-web-zdt-cutover`],
		).toEqual({
			failover: {
				service: candidate.domainServices["1"],
				fallback: "previous-1",
			},
		});
		expect(
			router.http?.routers?.[`${compose.appName}-1-websecure`]?.priority,
		).toBe(1_000_000);
		const wait = getWaitTraefikRoutersCommand({
			[`${compose.appName}-1-web`]: `${compose.appName}-1-web-zdt-cutover`,
		});
		expect(wait).toContain(`routers/${compose.appName}-1-web\\@file`);
		expect(wait).toContain(`"service":"${compose.appName}-1-web-zdt-cutover"`);
		const recoverableLock = getAcquireComposeActivationLockCommand(
			"/runtime/.activation.lock",
			deploymentId,
			"/runtime/activation.json",
		);
		expect(recoverableLock).toContain("journal_deployment");
		expect(recoverableLock).toContain("deployment-id");
	});
});

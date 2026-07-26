import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeploymentId } from "@dokploy/server/db/schema/deployment";
import {
	assertComposeBuildServerDeploymentReady,
	assertComposeBuildServerRuntimeSelection,
	assertComposeBuildServerSelection,
	assertComposeBuildServerSupported,
	type ComposeActivationJournal,
	type ComposeBuildServerDomain,
	type ComposeRuntimeReleaseState,
	createComposeReleaseTraefikRouterConfig,
	createComposeReleaseTraefikServiceConfig,
	createRuntimeComposeManifest,
	detectComposeLegacyRouterFallbacks,
	getAcquireComposeActivationLockCommand,
	getCancellableComposeCommand,
	getComposeBuildPushCommand,
	getComposeBuildServerCleanupIds,
	getComposeConfigCommand,
	getComposeDomainRouterNames,
	getComposeRegistryLoginCommand,
	getComposeReleaseProjectName,
	getComposeReleaseServiceAlias,
	getComposeRuntimeDrainSeconds,
	getComposeRuntimeReadinessTimeoutSeconds,
	getObserveTraefikServicesCommand,
	getRestoreLegacyTraefikRoutersCommand,
	getRuntimeDeployCommand,
	getRuntimePullCommands,
	getTraefikRoutersSnapshotCommand,
	getWaitTraefikRoutersCommand,
	getWaitTraefikServicesCommand,
	getWriteActivationJournalCommand,
	normalizeDockerPlatform,
	validateComposeBuildServerSpecification,
} from "@dokploy/server/utils/builders/compose-build-server";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { quote } from "shell-quote";
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
	it("generates deployment IDs that are valid immutable Docker tags", () => {
		const ids = Array.from({ length: 100 }, generateDeploymentId);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
			expect(id).toHaveLength(21);
		}
	});

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

	it("revalidates mutable Build Server state at deployment time", () => {
		const runtimeSelection = {
			organizationId: validSelection.organizationId,
			server: validSelection.server,
			registry: validSelection.registry,
		};
		expect(() =>
			assertComposeBuildServerRuntimeSelection(runtimeSelection),
		).not.toThrow();
		expect(() =>
			assertComposeBuildServerRuntimeSelection({
				...runtimeSelection,
				server: {
					...runtimeSelection.server,
					serverType: "deploy",
				},
			}),
		).toThrow("active Build Server");
		expect(() =>
			assertComposeBuildServerRuntimeSelection({
				...runtimeSelection,
				server: {
					...runtimeSelection.server,
					serverStatus: "inactive",
				},
			}),
		).toThrow("active Build Server");
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

	it("normalizes Docker engine architecture aliases", () => {
		expect(normalizeDockerPlatform("linux/x86_64")).toBe("linux/amd64");
		expect(normalizeDockerPlatform("aarch64")).toBe("linux/arm64");
	});

	it("rejects an implicit Apple Silicon build for an x86_64 runtime", () => {
		expect(() =>
			validateComposeBuildServerSpecification(
				apiCompose({
					build: ".",
					image: `registry.example.com/flots/api:${deploymentId}`,
				}),
				registry,
				deploymentId,
				[],
				[apiDomain()],
				{
					buildPlatform: "linux/aarch64",
					runtimePlatform: "linux/x86_64",
				},
			),
		).toThrow(
			'Buildable service "api" would default to Build Server platform "linux/arm64", but the runtime server uses "linux/amd64". Add platform: linux/amd64',
		);
	});

	it("accepts an explicit runtime platform on a cross-architecture build", () => {
		expect(() =>
			validateComposeBuildServerSpecification(
				apiCompose({
					build: ".",
					platform: "linux/amd64",
					image: `registry.example.com/flots/api:${deploymentId}`,
				}),
				registry,
				deploymentId,
				[],
				[apiDomain()],
				{
					buildPlatform: "linux/arm64",
					runtimePlatform: "linux/amd64",
				},
			),
		).not.toThrow();
	});

	it("accepts a multi-platform image that includes the runtime platform", () => {
		expect(() =>
			validateComposeBuildServerSpecification(
				apiCompose({
					build: {
						context: ".",
						platforms: ["linux/arm64", "linux/amd64"],
					},
					image: `registry.example.com/flots/api:${deploymentId}`,
				}),
				registry,
				deploymentId,
				[],
				[apiDomain()],
				{
					buildPlatform: "linux/arm64",
					runtimePlatform: "linux/amd64",
				},
			),
		).not.toThrow();
	});

	it("does not require platform when Docker engines have the same architecture", () => {
		expect(() =>
			validateComposeBuildServerSpecification(
				apiCompose({
					build: ".",
					image: `registry.example.com/flots/api:${deploymentId}`,
				}),
				registry,
				deploymentId,
				[],
				[apiDomain()],
				{
					buildPlatform: "linux/aarch64",
					runtimePlatform: "linux/arm64",
				},
			),
		).not.toThrow();
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

	it("rejects an enabled Build Server before deployment when Domains are missing", () => {
		expect(() =>
			assertComposeBuildServerDeploymentReady({
				...compose,
				buildServerId: "build-1",
				buildRegistryId: "registry-1",
				domains: [],
			}),
		).toThrow("at least one Dokploy Domain");
		expect(() =>
			assertComposeBuildServerDeploymentReady({
				...compose,
				buildServerId: null,
				buildRegistryId: null,
				domains: [],
			}),
		).not.toThrow();
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

	it("cancels only the wrapped Compose command when its request file appears", async () => {
		const directory = mkdtempSync(join(tmpdir(), "dokploy-compose-cancel-"));
		const cancellationRequest = join(directory, "cancel");
		const completed = join(directory, "completed");
		const command = getCancellableComposeCommand(
			`sleep 10; touch ${quote([completed])}`,
			cancellationRequest,
		);
		const startedAt = Date.now();
		const unrelated = spawn("sleep", ["10"]);

		try {
			const child = spawn("bash", ["-c", command], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			setTimeout(() => writeFileSync(cancellationRequest, ""), 100);

			const exitCode = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});

			expect(exitCode).toBe(130);
			expect(stderr).toContain("Compose deployment cancellation requested");
			expect(existsSync(completed)).toBe(false);
			expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
			expect(Date.now() - startedAt).toBeLessThan(5_000);
		} finally {
			unrelated.kill("SIGTERM");
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("retains every recorded Build Server for checkout cleanup", () => {
		expect(
			getComposeBuildServerCleanupIds("build-current", [
				{ buildServerId: "build-old" },
				{ buildServerId: "build-current" },
				{ buildServerId: null },
			]),
		).toEqual(["build-current", "build-old"]);
		expect(
			getComposeBuildServerCleanupIds(null, [
				{ buildServerId: "build-disabled" },
			]),
		).toEqual(["build-disabled"]);
	});

	it("reads persisted release timings and preserves legacy defaults", () => {
		const legacy = { timings: undefined };
		expect(getComposeRuntimeReadinessTimeoutSeconds(legacy)).toBe(120);
		expect(getComposeRuntimeDrainSeconds(legacy)).toBe(30);

		const persisted = {
			timings: {
				readinessTimeoutSeconds: 240,
				stabilizationSeconds: 45,
				drainSeconds: 90,
			},
		};
		expect(getComposeRuntimeReadinessTimeoutSeconds(persisted)).toBe(240);
		expect(getComposeRuntimeDrainSeconds(persisted)).toBe(90);
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
		const promotedRouter = createComposeReleaseTraefikRouterConfig({
			appName: compose.appName,
			domains,
			candidate,
		});
		expect(promotedRouter.http?.services).toBeUndefined();
		expect(promotedRouter.http?.middlewares).toBeUndefined();
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

	it("detects zero, partial and complete legacy router fallbacks", () => {
		const routerNames = getComposeDomainRouterNames(compose.appName, domains);
		const routerSnapshot = routerNames.map((routerName) => ({
			name: `${routerName}@docker`,
			provider: "docker",
			status: "enabled",
			service: `${routerName}-service`,
		}));

		expect(
			detectComposeLegacyRouterFallbacks(compose.appName, domains, []),
		).toEqual({});

		const partial = detectComposeLegacyRouterFallbacks(
			compose.appName,
			domains,
			[
				routerSnapshot[0],
				{
					...routerSnapshot[1],
					status: "disabled",
				},
				{
					...routerSnapshot[2],
					provider: "file",
				},
			],
		);
		expect(partial).toEqual({
			[routerNames[0]!]: {
				routerTarget: `${routerNames[0]}-service`,
				fallbackService: `${routerNames[0]}-service@docker`,
			},
		});

		const complete = detectComposeLegacyRouterFallbacks(
			compose.appName,
			domains,
			routerSnapshot,
		);
		expect(Object.keys(complete)).toEqual(routerNames);
		expect(getTraefikRoutersSnapshotCommand()).toContain("/api/http/routers");
	});

	it("creates failover only for legacy routers proven to exist", () => {
		const candidate: ComposeRuntimeReleaseState = {
			version: 1,
			composeId: "compose-1",
			deploymentId,
			projectName: getComposeReleaseProjectName(compose.appName, deploymentId),
			manifestPath: "/runtime.json",
			serviceConfigPath: "/service.yml",
			routerConfigPath: "/router.yml",
			domainServices: {
				"1": "candidate-backend",
				"2": "candidate-frontend",
				"3": "candidate-admin",
			},
			activatedAt: new Date(0).toISOString(),
		};
		const legacyFallbacks = {
			[`${compose.appName}-1-web`]: {
				routerTarget: `${compose.appName}-1-web`,
				fallbackService: `${compose.appName}-1-web@docker`,
			},
		};
		const router = createComposeReleaseTraefikRouterConfig({
			appName: compose.appName,
			domains,
			candidate,
			legacyFallbacks,
		});
		expect(
			router.http?.services?.[`${compose.appName}-1-web-zdt-cutover`],
		).toEqual({
			failover: {
				service: "candidate-backend",
				fallback: `${compose.appName}-1-web@docker`,
			},
		});
		expect(
			router.http?.services?.[`${compose.appName}-1-websecure-zdt-cutover`],
		).toBeUndefined();
		expect(
			router.http?.routers?.[`${compose.appName}-1-websecure`]?.service,
		).toBe("candidate-backend");

		const journal: ComposeActivationJournal = {
			version: 1,
			phase: "routed",
			candidate,
			previous: null,
			legacyProject: true,
			legacyFallbacks,
		};
		const journalCommand = getWriteActivationJournalCommand(
			"/runtime/activation.json",
			journal,
		);
		const encodedJournal = journalCommand
			.match(/echo ([^ ]+) \| base64/)?.[1]
			?.replaceAll("\\=", "=");
		expect(
			JSON.parse(Buffer.from(encodedJournal || "", "base64").toString()),
		).toEqual(journal);

		const rollback = getRestoreLegacyTraefikRoutersCommand(
			"/runtime/router.yml",
			legacyFallbacks,
		);
		expect(rollback).toContain(`routers/${compose.appName}-1-web\\@docker`);
		expect(rollback).toContain(`"service":"${compose.appName}-1-web"`);
		const noFallbackRollback = getRestoreLegacyTraefikRoutersCommand(
			"/runtime/router.yml",
			{},
		);
		expect(noFallbackRollback).toContain("rm -f");
		expect(noFallbackRollback).not.toContain("/api/http/routers");
	});

	it("generates syntactically valid Bash for every Traefik command", () => {
		const commands = [
			getCancellableComposeCommand("docker compose build --push", "/cancel"),
			getTraefikRoutersSnapshotCommand(),
			getWaitTraefikServicesCommand(["candidate-service"], 120),
			getWaitTraefikRoutersCommand({ "candidate-router": "candidate-service" }),
			getObserveTraefikServicesCommand(["candidate-service"], 30),
			getRestoreLegacyTraefikRoutersCommand("/runtime/router.yml", {
				"legacy-router": {
					routerTarget: "legacy-service@docker",
					fallbackService: "legacy-service@docker",
				},
			}),
		];

		for (const command of commands) {
			const result = spawnSync("bash", ["-n", "-c", command], {
				encoding: "utf8",
			});
			expect(result.status, result.stderr).toBe(0);
		}
	});
});

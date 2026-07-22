import {
	assertComposeBuildServerSelection,
	assertComposeBuildServerSupported,
	createRuntimeComposeManifest,
	getComposeBuildPushCommand,
	getComposeConfigCommand,
	getComposeRegistryLoginCommand,
	getRuntimeDeployCommand,
	getRuntimePullCommands,
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

const flotsCompose = (): ComposeSpecification => ({
	services: {
		"backend-staging": {
			build: { context: ".", dockerfile: "backend/Dockerfile" },
			image: `registry.example.com/flots/backend:${deploymentId}`,
		},
		"scheduler-staging": {
			image: `registry.example.com/flots/backend:${deploymentId}`,
			command: ["php", "artisan", "schedule:work"],
		},
		"frontend-staging": {
			build: { context: "frontend" },
			image: `registry.example.com/flots/frontend:${deploymentId}`,
		},
		"back-office-staging": {
			build: { context: "back-office" },
			image: `registry.example.com/flots/back-office:${deploymentId}`,
		},
	},
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
				{ services: { scheduler: { image: "busybox" } } },
				registry,
				deploymentId,
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
				{ services: { api: { build: ".", image } } },
				registry,
				deploymentId,
			),
		).toThrow(message);
	});

	it("rejects two builds targeting the same image", () => {
		const image = `registry.example.com/flots/api:${deploymentId}`;
		expect(() =>
			validateComposeBuildServerSpecification(
				{
					services: {
						api: { build: "./api", image },
						worker: { build: "./worker", image },
					},
				},
				registry,
				deploymentId,
			),
		).toThrow("target the same image");
	});

	it.each([
		[
			"bind mount",
			{
				services: {
					api: {
						build: ".",
						image: `registry.example.com/flots/api:${deploymentId}`,
						volumes: [{ type: "bind", source: "/tmp/data", target: "/data" }],
					},
				},
			},
			"bind mount",
		],
		[
			"configs.file",
			{
				services: {
					api: {
						build: ".",
						image: `registry.example.com/flots/api:${deploymentId}`,
					},
				},
				configs: { local: { file: "/tmp/config" } },
			},
			"configs.file",
		],
		[
			"secrets.file",
			{
				services: {
					api: {
						build: ".",
						image: `registry.example.com/flots/api:${deploymentId}`,
					},
				},
				secrets: { local: { file: "/tmp/secret" } },
			},
			"secrets.file",
		],
	] as const)("rejects a runtime %s", (_name, specification, message) => {
		expect(() =>
			validateComposeBuildServerSpecification(
				specification as ComposeSpecification,
				registry,
				deploymentId,
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
			),
		).toThrow("Dokploy file mount");
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
		const runtime = createRuntimeComposeManifest(flotsCompose());
		for (const service of Object.values(runtime.services || {})) {
			expect(service).not.toHaveProperty("build");
		}
		expect(runtime.services?.["scheduler-staging"]?.image).toBe(
			`registry.example.com/flots/backend:${deploymentId}`,
		);
	});

	it("pulls immutable images before an activation that cannot build", () => {
		const pulls = getRuntimePullCommands(compose, "/tmp/runtime.json", [
			"backend-staging",
		]);
		expect(pulls.every((command) => !command.includes(" up "))).toBe(true);
		expect(pulls.every((command) => !command.includes("--build"))).toBe(true);
		expect(pulls[0]).toContain("pull --policy always backend-staging");
		expect(pulls[1]).toContain("pull --policy missing");
		const deploy = getRuntimeDeployCommand(compose, "/tmp/runtime.json");
		expect(deploy).toContain("up -d --no-build --pull never --remove-orphans");
		expect(deploy).not.toContain("--build");
	});
});
